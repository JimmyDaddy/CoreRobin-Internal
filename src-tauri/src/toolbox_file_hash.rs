use crate::error::CommandError;
use crate::toolbox_inputs::{FILE_CHUNK_BYTES, FileJobKey, InputReader, ToolboxInputs};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileHashRequest {
    pub request_id: String,
    pub job: FileJobKey,
    pub token: String,
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
    pub generation: u64,
    pub reset_epoch: u64,
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
        inputs: Arc<ToolboxInputs>,
        on_progress: Channel<FileHashProgress>,
    ) -> Result<FileHashResult, CommandError> {
        if request.request_id.trim().is_empty() || request.request_id.len() > 128 {
            return Err(CommandError::new(
                "invalid_request",
                "A bounded request ID is required.",
            ));
        }
        let reader = inputs.reader(&request.job, &request.token)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self.cancel.lock().map_err(|_| unavailable())?;
            if guard.is_some() {
                return Err(CommandError::new(
                    "hash_busy",
                    "Only one file hash can run at a time.",
                ));
            }
            *guard = Some(Arc::clone(&cancel));
        }
        // Native reads, SHA-256 and progress are off the service/control thread.
        let joined = tauri::async_runtime::spawn_blocking(move || {
            hash_reader(reader, &request.request_id, &cancel, |event| {
                on_progress.send(event).map_err(|_| {
                    CommandError::new("interrupted", "The file hash page disconnected.")
                })
            })
        })
        .await;
        if let Ok(mut guard) = self.cancel.lock() {
            *guard = None;
        }
        joined.map_err(|_| unavailable())?
    }
}

fn hash_reader(
    reader: InputReader,
    request_id: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(FileHashProgress) -> Result<(), CommandError>,
) -> Result<FileHashResult, CommandError> {
    let total_bytes = reader.metadata().byte_length;
    let mut digest = Sha256::new();
    let mut bytes_read = 0_u64;
    let mut last_progress = Instant::now();
    loop {
        check_cancel(cancel)?;
        // Empty files are read once too, preserving identity/cancel checks.
        let bytes = reader.read(bytes_read, FILE_CHUNK_BYTES)?;
        digest.update(&bytes);
        bytes_read = bytes_read
            .checked_add(bytes.len() as u64)
            .ok_or_else(unavailable)?;
        check_cancel(cancel)?;
        if bytes_read == total_bytes {
            break;
        }
        if bytes.is_empty() {
            return Err(CommandError::new(
                "file_changed",
                "The selected file changed while being read.",
            ));
        }
        if last_progress.elapsed() >= Duration::from_millis(250) {
            progress(FileHashProgress {
                request_id: request_id.into(),
                bytes_read,
                total_bytes,
                phase: "hashing".into(),
            })?;
            last_progress = Instant::now();
        }
    }
    reader.revalidate()?;
    check_cancel(cancel)?;
    let digest = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    progress(FileHashProgress {
        request_id: request_id.into(),
        bytes_read,
        total_bytes,
        phase: "completed".into(),
    })?;
    Ok(FileHashResult {
        request_id: request_id.into(),
        path_hint: reader.metadata().display_name.clone(),
        bytes_read,
        digest,
        generation: reader.metadata().generation,
        reset_epoch: reader.metadata().reset_epoch,
    })
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), CommandError> {
    if cancel.load(Ordering::Acquire) {
        Err(CommandError::new(
            "cancelled",
            "File hashing was cancelled.",
        ))
    } else {
        Ok(())
    }
}
fn unavailable() -> CommandError {
    CommandError::internal("The file hash service is unavailable.")
}

#[cfg(test)]
#[path = "toolbox_file_hash_tests.rs"]
mod tests;
