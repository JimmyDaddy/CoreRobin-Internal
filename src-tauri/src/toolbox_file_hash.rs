use std::fs::{File, Metadata, symlink_metadata};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

use crate::error::CommandError;

const BUFFER_SIZE: usize = 1024 * 1024;
const MAX_PROGRESS_INTERVAL_MS: u128 = 250;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashRequest {
    pub request_id: String,
    pub path: String,
    pub generation: Option<u64>,
    pub reset_epoch: Option<u64>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashProgress {
    pub request_id: String,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub phase: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashResult {
    pub request_id: String,
    pub path_hint: String,
    pub bytes_read: u64,
    pub digest: String,
    pub generation: Option<u64>,
    pub reset_epoch: Option<u64>,
}

#[derive(Default)]
pub struct FileHashManager {
    cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl FileHashManager {
    pub fn cancel(&self) -> bool {
        let Ok(guard) = self.cancel.lock() else {
            return false;
        };
        let Some(flag) = guard.as_ref() else {
            return false;
        };
        flag.store(true, Ordering::Release);
        true
    }

    pub async fn run(
        &self,
        request: FileHashRequest,
        on_progress: Channel<FileHashProgress>,
    ) -> Result<FileHashResult, CommandError> {
        if request.request_id.trim().is_empty() {
            return Err(CommandError::new(
                "invalid_request",
                "requestId is required.",
            ));
        }
        let path = validate_input_path(&request.path)?;
        let start_metadata = file_identity(&path)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self
                .cancel
                .lock()
                .map_err(|_| CommandError::internal("File hash state is unavailable."))?;
            if guard.is_some() {
                return Err(CommandError::new(
                    "hash_busy",
                    "Only one file hash can run at a time.",
                ));
            }
            *guard = Some(Arc::clone(&cancel));
        }
        let request_id = request.request_id.clone();
        let generation = request.generation;
        let reset_epoch = request.reset_epoch;
        let progress = on_progress;
        let joined = tauri::async_runtime::spawn_blocking(move || {
            hash_file(
                path,
                start_metadata,
                request_id,
                generation,
                reset_epoch,
                cancel,
                progress,
            )
        })
        .await;
        if let Ok(mut guard) = self.cancel.lock() {
            *guard = None;
        }
        joined.map_err(|error| CommandError::internal(format!("File hash task failed: {error}")))?
    }
}

fn validate_input_path(raw: &str) -> Result<PathBuf, CommandError> {
    if raw.trim().is_empty() {
        return Err(CommandError::new("invalid_file", "Choose a file first."));
    }
    let candidate = Path::new(raw);
    let metadata = symlink_metadata(candidate)
        .map_err(|_| CommandError::new("file_unavailable", "The selected file is unavailable."))?;
    if !metadata.file_type().is_file() {
        return Err(CommandError::new(
            "file_not_regular",
            "Only a regular file can be hashed.",
        ));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| CommandError::new("file_unavailable", "The selected file is unavailable."))?;
    let canonical_metadata = symlink_metadata(&canonical)
        .map_err(|_| CommandError::new("file_unavailable", "The selected file is unavailable."))?;
    if !canonical_metadata.file_type().is_file() {
        return Err(CommandError::new(
            "file_not_regular",
            "Only a regular file can be hashed.",
        ));
    }
    Ok(canonical)
}

fn file_identity(path: &Path) -> Result<Metadata, CommandError> {
    std::fs::metadata(path)
        .map_err(|_| CommandError::new("file_unavailable", "The selected file is unavailable."))
}

fn hash_file(
    path: PathBuf,
    start_metadata: Metadata,
    request_id: String,
    generation: Option<u64>,
    reset_epoch: Option<u64>,
    cancel: Arc<AtomicBool>,
    progress: Channel<FileHashProgress>,
) -> Result<FileHashResult, CommandError> {
    let total_bytes = start_metadata.len();
    let file = File::open(&path).map_err(|_| {
        CommandError::new("file_read_failed", "The selected file could not be read.")
    })?;
    let mut reader = BufReader::with_capacity(BUFFER_SIZE, file);
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    let mut digest = Sha256::new();
    let mut bytes_read = 0_u64;
    let mut last_progress = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(CommandError::new(
                "cancelled",
                "File hashing was cancelled.",
            ));
        }
        let read = reader.read(&mut buffer).map_err(|_| {
            CommandError::new("file_read_failed", "The selected file could not be read.")
        })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        bytes_read = bytes_read.saturating_add(read as u64);
        if last_progress.elapsed().as_millis() >= MAX_PROGRESS_INTERVAL_MS {
            let _ = progress.send(FileHashProgress {
                request_id: request_id.clone(),
                bytes_read,
                total_bytes,
                phase: "hashing".to_owned(),
            });
            last_progress = std::time::Instant::now();
        }
    }
    let end_metadata = file_identity(&path)?;
    if file_changed(&start_metadata, &end_metadata) {
        return Err(CommandError::new(
            "file_changed",
            "The file changed while it was being read.",
        ));
    }
    let digest = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let _ = progress.send(FileHashProgress {
        request_id: request_id.clone(),
        bytes_read,
        total_bytes,
        phase: "completed".to_owned(),
    });
    Ok(FileHashResult {
        request_id,
        path_hint: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file")
            .to_owned(),
        bytes_read,
        digest,
        generation,
        reset_epoch,
    })
}

fn modified_at(metadata: &Metadata) -> Option<SystemTime> {
    metadata.modified().ok()
}

fn file_changed(start: &Metadata, end: &Metadata) -> bool {
    if start.len() != end.len() || modified_at(start) != modified_at(end) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        start.dev() != end.dev() || start.ino() != end.ino()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_symlinked_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        let link = directory.path().join("link.txt");
        File::create(&target)
            .unwrap()
            .write_all(b"content")
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        let error = validate_input_path(link.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, "file_not_regular");
    }
}
