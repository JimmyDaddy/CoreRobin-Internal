use std::collections::HashMap;
use std::env;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use crate::error::CommandError;
use crate::models::{
    DuplicateFileGroup, FileInsightFile, FileInsightsPhase, FileInsightsProgress, FileInsightsScan,
};
use crate::private_storage;

const MIN_DUPLICATE_SIZE_BYTES: u64 = 1024 * 1024;
const MIN_LONG_UNMODIFIED_SIZE_BYTES: u64 = 100 * 1024 * 1024;
const LONG_UNMODIFIED_AGE: Duration = Duration::from_secs(180 * 24 * 60 * 60);
const MAX_SCANNED_ENTRIES: usize = 200_000;
const MAX_CANDIDATE_FILES: usize = 50_000;
const MAX_HASHED_FILES: usize = 2_000;
const MAX_HASHED_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_DUPLICATE_GROUPS: usize = 100;
const MAX_LONG_UNMODIFIED_FILES: usize = 200;
const MAX_FILE_INSIGHTS_CACHE_BYTES: u64 = 8 * 1_024 * 1_024;
const FILE_INSIGHTS_CACHE_VERSION: u8 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInsightsCachePayload<'a> {
    version: u8,
    saved_at_ms: u64,
    snapshot: &'a FileInsightsScan,
}

#[derive(Default)]
pub struct FileInsightsCoordinator {
    active: AtomicBool,
    cancellation: Mutex<Option<Arc<AtomicBool>>>,
}

impl FileInsightsCoordinator {
    pub fn begin(&self) -> Result<Arc<AtomicBool>, CommandError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                CommandError::new(
                    "file_insights_scan_in_progress",
                    "A file insights scan is already running.",
                )
            })?;
        let cancellation = Arc::new(AtomicBool::new(false));
        match self.cancellation.lock() {
            Ok(mut slot) => *slot = Some(Arc::clone(&cancellation)),
            Err(_) => {
                self.active.store(false, Ordering::Release);
                return Err(CommandError::internal(
                    "The file insights cancellation lock was poisoned.",
                ));
            }
        }
        Ok(cancellation)
    }

    pub fn finish(&self, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut slot) = self.cancellation.lock()
            && slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, cancellation))
        {
            *slot = None;
        }
        self.active.store(false, Ordering::Release);
    }

    pub fn cancel(&self) -> Result<(), CommandError> {
        let slot = self.cancellation.lock().map_err(|_| {
            CommandError::internal("The file insights cancellation lock was poisoned.")
        })?;
        if let Some(cancellation) = slot.as_ref() {
            cancellation.store(true, Ordering::Release);
        }
        Ok(())
    }
}

#[derive(Clone)]
struct CandidateFile {
    path: PathBuf,
    size_bytes: u64,
    modified_at: Option<SystemTime>,
}

pub fn scan_file_insights(
    cancellation: &AtomicBool,
    on_progress: &mut impl FnMut(FileInsightsProgress),
) -> Result<FileInsightsScan, CommandError> {
    let started_at = Instant::now();
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "The current user's home directory could not be determined.",
        )
    })?;
    let roots = [
        "Desktop",
        "Documents",
        "Downloads",
        "Movies",
        "Music",
        "Pictures",
    ]
    .into_iter()
    .map(|name| home.join(name))
    .filter(|path| {
        fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    })
    .collect::<Vec<_>>();

    let mut stack = roots;
    let mut candidates = Vec::new();
    let mut long_unmodified_files = Vec::new();
    let mut scanned_entry_count = 0usize;
    let mut unreadable_entry_count = 0usize;
    let mut truncated = false;
    let old_before = SystemTime::now()
        .checked_sub(LONG_UNMODIFIED_AGE)
        .unwrap_or(UNIX_EPOCH);

    while let Some(directory) = stack.pop() {
        ensure_not_cancelled(cancellation)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                unreadable_entry_count += 1;
                continue;
            }
        };
        for entry in entries {
            ensure_not_cancelled(cancellation)?;
            if scanned_entry_count >= MAX_SCANNED_ENTRIES {
                truncated = true;
                stack.clear();
                break;
            }
            scanned_entry_count += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    unreadable_entry_count += 1;
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    unreadable_entry_count += 1;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            let modified_at = metadata.modified().ok();
            if metadata.len() >= MIN_LONG_UNMODIFIED_SIZE_BYTES
                && modified_at.is_some_and(|modified| modified <= old_before)
            {
                long_unmodified_files.push(to_file_insight(&path, &metadata));
            }
            if metadata.len() >= MIN_DUPLICATE_SIZE_BYTES {
                if candidates.len() >= MAX_CANDIDATE_FILES {
                    truncated = true;
                } else {
                    candidates.push(CandidateFile {
                        path,
                        size_bytes: metadata.len(),
                        modified_at,
                    });
                }
            }

            if scanned_entry_count.is_multiple_of(500) {
                on_progress(FileInsightsProgress {
                    phase: FileInsightsPhase::Discovering,
                    scanned_entry_count,
                    candidate_file_count: candidates.len(),
                    hashed_file_count: 0,
                    current_path: directory.to_string_lossy().into_owned(),
                });
            }
        }
    }

    long_unmodified_files.sort_by_key(|file| std::cmp::Reverse(file.size_bytes));
    long_unmodified_files.truncate(MAX_LONG_UNMODIFIED_FILES);

    let mut by_size: HashMap<u64, Vec<CandidateFile>> = HashMap::new();
    for candidate in candidates.iter().cloned() {
        by_size
            .entry(candidate.size_bytes)
            .or_default()
            .push(candidate);
    }
    let mut hash_candidates = by_size
        .into_values()
        .filter(|group| group.len() > 1)
        .flatten()
        .collect::<Vec<_>>();
    hash_candidates.sort_by_key(|file| std::cmp::Reverse(file.size_bytes));

    let mut hashed_file_count = 0usize;
    let mut hashed_bytes = 0u64;
    let mut by_digest: HashMap<(u64, String), Vec<FileInsightFile>> = HashMap::new();
    for candidate in hash_candidates {
        ensure_not_cancelled(cancellation)?;
        if hashed_file_count >= MAX_HASHED_FILES
            || hashed_bytes.saturating_add(candidate.size_bytes) > MAX_HASHED_BYTES
        {
            truncated = true;
            break;
        }
        if let Ok(digest) = hash_candidate(&candidate) {
            hashed_file_count += 1;
            hashed_bytes = hashed_bytes.saturating_add(candidate.size_bytes);
            let metadata = match fs::symlink_metadata(&candidate.path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    unreadable_entry_count += 1;
                    continue;
                }
            };
            by_digest
                .entry((candidate.size_bytes, digest))
                .or_default()
                .push(to_file_insight(&candidate.path, &metadata));
        } else {
            unreadable_entry_count += 1;
        }
        if hashed_file_count.is_multiple_of(10) {
            on_progress(FileInsightsProgress {
                phase: FileInsightsPhase::Hashing,
                scanned_entry_count,
                candidate_file_count: candidates.len(),
                hashed_file_count,
                current_path: candidate.path.to_string_lossy().into_owned(),
            });
        }
    }

    let mut duplicate_groups = by_digest
        .into_iter()
        .filter_map(|((size_bytes, digest), mut files)| {
            if files.len() < 2 {
                return None;
            }
            files.sort_by(|left, right| left.path.cmp(&right.path));
            Some(DuplicateFileGroup {
                digest,
                size_bytes,
                reclaimable_bytes: size_bytes.saturating_mul(files.len().saturating_sub(1) as u64),
                files,
            })
        })
        .collect::<Vec<_>>();
    duplicate_groups.sort_by_key(|group| std::cmp::Reverse(group.reclaimable_bytes));
    duplicate_groups.truncate(MAX_DUPLICATE_GROUPS);

    Ok(FileInsightsScan {
        sampled_at_ms: now_millis(),
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        scanned_entry_count,
        candidate_file_count: candidates.len(),
        hashed_file_count,
        duplicate_groups,
        long_unmodified_files,
        unreadable_entry_count,
        truncated,
    })
}

pub fn load_file_insights_cache(path: &Path) -> Result<Option<String>, CommandError> {
    let bytes = match private_storage::read_limited(path, MAX_FILE_INSIGHTS_CACHE_BYTES) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    Ok(String::from_utf8(bytes).ok())
}

pub fn save_file_insights_snapshot_cache(
    path: &Path,
    snapshot: &FileInsightsScan,
) -> Result<(), CommandError> {
    save_file_insights_snapshot_cache_at(path, snapshot, now_millis())
}

pub fn save_file_insights_snapshot_cache_at(
    path: &Path,
    snapshot: &FileInsightsScan,
    saved_at_ms: u64,
) -> Result<(), CommandError> {
    let serialized = serde_json::to_string(&FileInsightsCachePayload {
        version: FILE_INSIGHTS_CACHE_VERSION,
        saved_at_ms,
        snapshot,
    })
    .map_err(|error| {
        CommandError::internal(format!("Could not encode the file insights cache: {error}"))
    })?;
    if u64::try_from(serialized.len()).unwrap_or(u64::MAX) > MAX_FILE_INSIGHTS_CACHE_BYTES {
        return Err(CommandError::new(
            "file_insights_cache_too_large",
            "The file insights cache is too large to retain safely.",
        ));
    }
    private_storage::write_atomic(path, serialized.as_bytes()).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely update the file insights cache: {error}"
        ))
    })
}

pub fn remove_file_insights_cache(path: &Path) -> Result<(), CommandError> {
    private_storage::remove(path).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely clear the file insights cache: {error}"
        ))
    })
}

fn hash_candidate(candidate: &CandidateFile) -> io::Result<String> {
    let before = fs::symlink_metadata(&candidate.path)?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() != candidate.size_bytes
        || before.modified().ok() != candidate.modified_at
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed before hashing",
        ));
    }
    let mut file = open_file_no_follow(&candidate.path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let after = file.metadata()?;
    if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed while hashing",
        ));
    }
    let digest = digest.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}

#[cfg(unix)]
fn open_file_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_file_no_follow(path: &Path) -> io::Result<File> {
    File::open(path)
}

fn to_file_insight(path: &Path, metadata: &Metadata) -> FileInsightFile {
    let logical_size_bytes = metadata.len();
    FileInsightFile {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        size_bytes: logical_size_bytes,
        logical_size_bytes,
        allocated_size_bytes: file_allocated_size(metadata),
        modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
    }
}

#[cfg(unix)]
fn file_allocated_size(metadata: &Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn file_allocated_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

fn ensure_not_cancelled(cancellation: &AtomicBool) -> Result<(), CommandError> {
    if cancellation.load(Ordering::Acquire) {
        Err(CommandError::new(
            "file_insights_scan_cancelled",
            "The file insights scan was cancelled.",
        ))
    } else {
        Ok(())
    }
}

fn home_directory() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn system_time_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
}

fn now_millis() -> u64 {
    system_time_millis(SystemTime::now()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        CandidateFile, FILE_INSIGHTS_CACHE_VERSION, hash_candidate, load_file_insights_cache,
        remove_file_insights_cache, save_file_insights_snapshot_cache_at, to_file_insight,
    };
    use crate::models::FileInsightsScan;

    #[test]
    fn hashes_stable_regular_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("sample.bin");
        fs::write(&path, b"CoreRobin file insights").expect("write fixture");
        let metadata = fs::symlink_metadata(&path).expect("fixture metadata");
        let candidate = CandidateFile {
            path,
            size_bytes: metadata.len(),
            modified_at: metadata.modified().ok(),
        };
        assert_eq!(
            hash_candidate(&candidate).expect("hash fixture"),
            "f05a8c8aee40ad12d55674e20d54ea5080329c1bf7452276f5cfbfd9270dfd35"
        );
    }

    #[test]
    fn records_logical_and_allocated_size_for_delete_revalidation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("evidence.bin");
        fs::write(&path, b"CoreRobin duplicate evidence").expect("write fixture");
        let metadata = fs::symlink_metadata(&path).expect("fixture metadata");

        let insight = to_file_insight(&path, &metadata);

        assert_eq!(insight.size_bytes, metadata.len());
        assert_eq!(insight.logical_size_bytes, metadata.len());
        assert!(insight.allocated_size_bytes > 0);
    }

    #[test]
    fn file_insights_cache_round_trips_and_clears() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let cache_path = directory.path().join("nested/file-insights-v1.json");
        let scan = FileInsightsScan {
            sampled_at_ms: 100,
            duration_ms: 20,
            scanned_entry_count: 3,
            candidate_file_count: 2,
            hashed_file_count: 2,
            duplicate_groups: Vec::new(),
            long_unmodified_files: Vec::new(),
            unreadable_entry_count: 0,
            truncated: false,
        };

        assert_eq!(load_file_insights_cache(&cache_path).unwrap(), None);
        save_file_insights_snapshot_cache_at(&cache_path, &scan, 1_234).unwrap();
        let serialized = load_file_insights_cache(&cache_path).unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            payload["version"].as_u64(),
            Some(u64::from(FILE_INSIGHTS_CACHE_VERSION)),
        );
        assert_eq!(payload["savedAtMs"].as_u64(), Some(1_234));
        assert_eq!(payload["snapshot"]["sampledAtMs"].as_u64(), Some(100));

        remove_file_insights_cache(&cache_path).unwrap();
        assert_eq!(load_file_insights_cache(&cache_path).unwrap(), None);
    }
}
