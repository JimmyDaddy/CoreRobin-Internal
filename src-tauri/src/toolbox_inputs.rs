//! Identity-bound inputs. No caller can read a path after it has been exchanged
//! for a token; cancellation never waits on the file's IO mutex.
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use serde::{Deserialize, Serialize};

use crate::error::CommandError;

pub const FILE_CHUNK_BYTES: usize = 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const MAX_FILE_JOBS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileJobKey {
    pub job_id: String,
    pub generation: u64,
    pub reset_epoch: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputRole {
    Input,
    Target,
    Expected,
    Logo,
    Font,
    Patch,
    Manifest,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputToken {
    pub token: String,
    pub job_id: String,
    pub session_id: String,
    pub generation: u64,
    pub reset_epoch: u64,
    pub role: InputRole,
    pub display_name: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    size: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl Identity {
    fn read(metadata: &Metadata) -> Self {
        Self {
            device: MetadataExt::dev(metadata),
            inode: MetadataExt::ino(metadata),
            size: metadata.len(),
            modified: metadata.modified().ok().map(|time| time.into_std()),
            #[cfg(unix)]
            changed: (
                cap_std::fs::MetadataExt::ctime(metadata),
                cap_std::fs::MetadataExt::ctime_nsec(metadata),
            ),
        }
    }
}

pub(crate) struct BoundInput {
    parent: Dir,
    selected_parent: PathBuf,
    parent_identity: (u64, u64),
    name: OsString,
    file: Mutex<File>,
    identity: Identity,
}

impl BoundInput {
    pub(crate) fn open(path: &Path, max_bytes: u64) -> Result<Self, CommandError> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(error("invalid_file", "Choose a regular local file."));
        }
        let name = path
            .file_name()
            .ok_or_else(|| error("invalid_file", "Choose a file."))?
            .to_owned();
        let parent_path = path
            .parent()
            .ok_or_else(|| error("invalid_file", "Choose a file."))?
            .canonicalize()
            .map_err(|_| unavailable())?;
        let parent =
            Dir::open_ambient_dir(&parent_path, ambient_authority()).map_err(|_| unavailable())?;
        let parent_metadata = parent.dir_metadata().map_err(|_| unavailable())?;
        let entry = parent.symlink_metadata(&name).map_err(|_| unavailable())?;
        ensure_regular(&entry)?;
        if entry.len() > max_bytes {
            return Err(error(
                "input_too_large",
                "The file exceeds this input role's size limit.",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        // A regular entry replaced by a FIFO between metadata and open must not
        // block a worker indefinitely. We still reject its handle afterwards.
        #[cfg(unix)]
        {
            use cap_fs_ext::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = parent
            .open_with(&name, &options)
            .map_err(|_| unavailable())?;
        let metadata = file.metadata().map_err(|_| unavailable())?;
        ensure_regular(&metadata)?;
        if Identity::read(&entry) != Identity::read(&metadata) {
            return Err(changed());
        }
        let bound = Self {
            parent,
            selected_parent: path.parent().expect("validated parent").to_path_buf(),
            parent_identity: (
                MetadataExt::dev(&parent_metadata),
                MetadataExt::ino(&parent_metadata),
            ),
            name,
            file: Mutex::new(file),
            identity: Identity::read(&metadata),
        };
        bound.revalidate()?;
        Ok(bound)
    }

    pub(crate) fn byte_length(&self) -> u64 {
        self.identity.size
    }

    pub(crate) fn display_name(&self) -> String {
        self.name.to_string_lossy().into_owned()
    }

    pub(crate) fn revalidate(&self) -> Result<(), CommandError> {
        let current_parent = Dir::open_ambient_dir(&self.selected_parent, ambient_authority())
            .map_err(|_| changed())?;
        let metadata = current_parent.dir_metadata().map_err(|_| changed())?;
        if (MetadataExt::dev(&metadata), MetadataExt::ino(&metadata)) != self.parent_identity {
            return Err(changed());
        }
        let entry = self
            .parent
            .symlink_metadata(&self.name)
            .map_err(|_| changed())?;
        ensure_regular(&entry)?;
        if Identity::read(&entry) != self.identity {
            return Err(changed());
        }
        Ok(())
    }

    pub(crate) fn read_chunk(
        &self,
        offset: u64,
        length: usize,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>, CommandError> {
        check_cancel(cancel)?;
        if length == 0 || length > FILE_CHUNK_BYTES || offset > self.identity.size {
            return Err(error(
                "invalid_range",
                "The requested file range is invalid.",
            ));
        }
        self.revalidate()?;
        let mut file = self
            .file
            .try_lock()
            .map_err(|_| error("input_busy", "Another read is in progress."))?;
        if Identity::read(&file.metadata().map_err(|_| changed())?) != self.identity {
            return Err(changed());
        }
        let wanted = (self.identity.size - offset).min(length as u64) as usize;
        let mut bytes = vec![0; wanted];
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| unavailable())?;
        file.read_exact(&mut bytes).map_err(|_| unavailable())?;
        check_cancel(cancel)?;
        if Identity::read(&file.metadata().map_err(|_| changed())?) != self.identity {
            return Err(changed());
        }
        drop(file);
        self.revalidate()?;
        Ok(bytes)
    }
}

struct RegisteredInput {
    token: InputToken,
    file: Arc<BoundInput>,
}

struct JobInputs {
    key: FileJobKey,
    session_id: String,
    tool_id: String,
    cancelled: AtomicBool,
    operations: AtomicUsize,
    inputs: Mutex<HashMap<String, RegisteredInput>>,
}

struct Operation(Arc<JobInputs>);
impl Operation {
    fn acquire(job: Arc<JobInputs>) -> Result<Self, CommandError> {
        check_cancel(&job.cancelled)?;
        job.operations
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| error("input_busy", "Another file operation is in progress."))?;
        let operation = Self(job);
        check_cancel(&operation.0.cancelled)?;
        Ok(operation)
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.operations.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Holds admission for a complete native streaming operation, including time
/// spent hashing a chunk. Cancellation cannot claim release between reads.
pub struct InputReader {
    operation: Operation,
    file: Arc<BoundInput>,
    token: InputToken,
}

impl InputReader {
    pub fn metadata(&self) -> &InputToken {
        &self.token
    }
    pub fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>, CommandError> {
        self.file
            .read_chunk(offset, length, &self.operation.0.cancelled)
    }
    pub fn revalidate(&self) -> Result<(), CommandError> {
        check_cancel(&self.operation.0.cancelled)?;
        self.file.revalidate()
    }
}

#[derive(Default)]
pub struct ToolboxInputs {
    jobs: Mutex<HashMap<String, Arc<JobInputs>>>,
}

impl ToolboxInputs {
    pub fn register(
        &self,
        key: FileJobKey,
        session_id: String,
        tool_id: String,
    ) -> Result<(), CommandError> {
        let mut jobs = self.jobs.lock().map_err(|_| unavailable())?;
        if jobs.len() >= MAX_FILE_JOBS {
            return Err(error(
                "resource_busy",
                "Too many file sessions are retained.",
            ));
        }
        if jobs.contains_key(&key.job_id) {
            return Err(error("job_exists", "The file session already exists."));
        }
        jobs.insert(
            key.job_id.clone(),
            Arc::new(JobInputs {
                key,
                session_id,
                tool_id,
                cancelled: AtomicBool::new(false),
                operations: AtomicUsize::new(0),
                inputs: Mutex::new(HashMap::new()),
            }),
        );
        Ok(())
    }

    fn job(&self, key: &FileJobKey) -> Result<Arc<JobInputs>, CommandError> {
        let job = self
            .jobs
            .lock()
            .map_err(|_| unavailable())?
            .get(&key.job_id)
            .cloned()
            .ok_or_else(|| error("job_not_found", "The file session no longer exists."))?;
        if job.key != *key {
            return Err(error(
                "stale_job",
                "The result belongs to an earlier page or reset.",
            ));
        }
        check_cancel(&job.cancelled)?;
        Ok(job)
    }

    /// Paths must come from the native selection dialog, never from an executor.
    #[cfg(test)]
    pub fn prepare(
        &self,
        key: &FileJobKey,
        role: InputRole,
        paths: &[PathBuf],
    ) -> Result<Vec<InputToken>, CommandError> {
        let operation = Operation::acquire(self.job(key)?)?;
        self.prepare_in_operation(key, role, paths, &operation)
    }

    /// Counts the native dialog as an owned operation too. Clear/cancel cannot
    /// claim complete release while a selection dialog is still outstanding.
    pub fn select(
        &self,
        key: &FileJobKey,
        role: InputRole,
        select: impl FnOnce() -> Result<Vec<PathBuf>, CommandError>,
    ) -> Result<Vec<InputToken>, CommandError> {
        let operation = Operation::acquire(self.job(key)?)?;
        role_budget(&operation.0.tool_id, role)?;
        let paths = select()?;
        check_cancel(&operation.0.cancelled)?;
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        self.prepare_in_operation(key, role, &paths, &operation)
    }

    fn prepare_in_operation(
        &self,
        key: &FileJobKey,
        role: InputRole,
        paths: &[PathBuf],
        operation: &Operation,
    ) -> Result<Vec<InputToken>, CommandError> {
        let (maximum, count, total_limit) = role_budget(&operation.0.tool_id, role)?;
        if paths.is_empty() || paths.len() > count {
            return Err(error("input_count", "Too many files for this input role."));
        }
        let mut prepared = Vec::with_capacity(paths.len());
        for path in paths {
            check_cancel(&operation.0.cancelled)?;
            let file = Arc::new(BoundInput::open(path, maximum)?);
            let token = InputToken {
                token: opaque_id()?,
                job_id: key.job_id.clone(),
                session_id: operation.0.session_id.clone(),
                generation: key.generation,
                reset_epoch: key.reset_epoch,
                role,
                display_name: file.display_name(),
                byte_length: file.byte_length(),
            };
            prepared.push(RegisteredInput { token, file });
        }
        let mut inputs = operation.0.inputs.lock().map_err(|_| unavailable())?;
        check_cancel(&operation.0.cancelled)?;
        let existing = inputs.values().filter(|input| input.token.role == role);
        let previous: Vec<_> = existing.collect();
        if previous.len() + prepared.len() > count || inputs.len() + prepared.len() > 32 {
            return Err(error(
                "input_count",
                "Release the previous selection before adding more files.",
            ));
        }
        let bytes = previous
            .iter()
            .map(|input| input.token.byte_length)
            .chain(prepared.iter().map(|input| input.token.byte_length))
            .try_fold(0_u64, u64::checked_add)
            .ok_or_else(|| error("input_too_large", "The input budget was exceeded."))?;
        if bytes > total_limit {
            return Err(error(
                "input_too_large",
                "The total input budget was exceeded.",
            ));
        }
        let result = prepared.iter().map(|input| input.token.clone()).collect();
        for input in prepared {
            inputs.insert(input.token.token.clone(), input);
        }
        Ok(result)
    }

    pub fn read(
        &self,
        key: &FileJobKey,
        token: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, CommandError> {
        self.reader(key, token)?.read(offset, length)
    }

    pub fn reader(&self, key: &FileJobKey, token: &str) -> Result<InputReader, CommandError> {
        let operation = Operation::acquire(self.job(key)?)?;
        let (file, token) = {
            let inputs = operation.0.inputs.lock().map_err(|_| unavailable())?;
            let input = inputs
                .get(token)
                .ok_or_else(|| error("invalid_token", "This input token is no longer valid."))?;
            (Arc::clone(&input.file), input.token.clone())
        };
        Ok(InputReader {
            operation,
            file,
            token,
        })
    }

    pub fn release(&self, key: &FileJobKey, tokens: &[String]) -> Result<(), CommandError> {
        let job = self.job(key)?;
        let mut inputs = job.inputs.lock().map_err(|_| unavailable())?;
        for token in tokens {
            inputs.remove(token);
        }
        Ok(())
    }

    pub fn revalidate_all(&self, key: &FileJobKey) -> Result<(), CommandError> {
        let operation = Operation::acquire(self.job(key)?)?;
        let files: Vec<_> = operation
            .0
            .inputs
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .map(|input| Arc::clone(&input.file))
            .collect();
        for file in files {
            check_cancel(&operation.0.cancelled)?;
            file.revalidate()?;
        }
        Ok(())
    }

    /// Returns false while a read/open is still running. That is stopping, not
    /// cancelled: the caller retains a visible release-unconfirmed resource.
    pub fn cancel(&self, job_id: &str) -> bool {
        let Ok(mut jobs) = self.jobs.lock() else {
            return false;
        };
        let Some(job) = jobs.get(job_id) else {
            return true;
        };
        job.cancelled.store(true, Ordering::Release);
        if job.operations.load(Ordering::Acquire) != 0 {
            return false;
        }
        jobs.remove(job_id);
        true
    }

    #[cfg(test)]
    pub fn retained_bytes(&self, job_id: &str) -> u64 {
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned())
            .and_then(|job| {
                job.inputs
                    .lock()
                    .ok()
                    .map(|inputs| inputs.values().map(|input| input.token.byte_length).sum())
            })
            .unwrap_or(0)
    }

    pub fn resource_state(&self, job_id: &str) -> Option<(u64, bool)> {
        let job = self.jobs.lock().ok()?.get(job_id).cloned()?;
        Some((
            job.operations.load(Ordering::Acquire) as u64 * FILE_CHUNK_BYTES as u64,
            job.cancelled.load(Ordering::Acquire),
        ))
    }
}

pub fn role_budget(tool: &str, role: InputRole) -> Result<(u64, usize, u64), CommandError> {
    use InputRole::*;
    let value = match (tool, role) {
        ("file-sha256", Input) => (u64::MAX, 1, u64::MAX),
        ("binary-patch-create", Input | Target) | ("patch-planner", Target) => {
            (16 * MIB, 1, 16 * MIB)
        }
        ("patch-planner", Input) => (16 * MIB, 8, 128 * MIB),
        ("binary-patch-apply", Input) => (16 * MIB, 1, 16 * MIB),
        ("binary-patch-apply", Patch | Expected) | ("binary-patch-inspector", Patch) => {
            (64 * MIB, 1, 64 * MIB)
        }
        ("integrity-manifest", Input) => (64 * MIB, 1, 64 * MIB),
        ("image-batch-watermark", Input) => (12 * MIB, 20, 80 * MIB),
        (
            "image-watermark"
            | "confidential-watermark"
            | "image-recipe"
            | "image-editor"
            | "invisible-watermark-write"
            | "invisible-watermark-check"
            | "recipient-tracking"
            | "robustness-lab"
            | "c2pa-inspector",
            Input,
        ) => (12 * MIB, 1, 12 * MIB),
        (
            "image-watermark"
            | "image-batch-watermark"
            | "confidential-watermark"
            | "image-editor"
            | "image-recipe",
            Logo,
        ) => (12 * MIB, 1, 12 * MIB),
        ("image-watermark" | "image-batch-watermark" | "confidential-watermark", Font) => {
            (4 * MIB, 1, 4 * MIB)
        }
        ("image-recipe" | "c2pa-inspector", Manifest) => (4 * MIB, 1, 4 * MIB),
        _ => {
            return Err(error(
                "invalid_input_role",
                "This input role is not allowed for the selected tool.",
            ));
        }
    };
    Ok(value)
}

pub(crate) fn opaque_id() -> Result<String, CommandError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        error(
            "random_unavailable",
            "Secure token generation is unavailable.",
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn ensure_regular(metadata: &Metadata) -> Result<(), CommandError> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            "file_not_regular",
            "Only regular files are accepted; links and special files are not.",
        ));
    }
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(error(
                "file_not_regular",
                "Reparse points are not accepted.",
            ));
        }
    }
    Ok(())
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), CommandError> {
    if cancel.load(Ordering::Acquire) {
        Err(error("cancelled", "The file operation was cancelled."))
    } else {
        Ok(())
    }
}
fn error(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message)
}
fn unavailable() -> CommandError {
    error(
        "file_unavailable",
        "The selected file is unavailable or could not be read.",
    )
}
fn changed() -> CommandError {
    error(
        "file_changed",
        "The selected file or its parent changed; select it again.",
    )
}

#[cfg(test)]
#[path = "toolbox_inputs_tests.rs"]
mod tests;
