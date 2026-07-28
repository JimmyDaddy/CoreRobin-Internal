use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::private_storage;

pub const APPLICATION_HISTORY_FILE_NAME: &str = "application-impact-history-v2.json";
const MAXIMUM_APPLICATION_HISTORY_BYTES: u64 = 32 * 1_024 * 1_024;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationHistoryStorage {
    pub payload: Option<String>,
    pub byte_size: u64,
    pub updated_at_ms: Option<u64>,
}

pub fn load(path: &Path) -> io::Result<ApplicationHistoryStorage> {
    let Some(bytes) = private_storage::read_limited(path, MAXIMUM_APPLICATION_HISTORY_BYTES)?
    else {
        return Ok(ApplicationHistoryStorage::default());
    };
    let payload = String::from_utf8(bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "application history is not UTF-8",
        )
    })?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "application history is not a regular file",
        ));
    }
    Ok(ApplicationHistoryStorage {
        byte_size: metadata.len(),
        updated_at_ms: metadata.modified().ok().and_then(system_time_millis),
        payload: Some(payload),
    })
}

pub fn save(path: &Path, payload: &str) -> io::Result<ApplicationHistoryStorage> {
    let byte_size = u64::try_from(payload.len()).unwrap_or(u64::MAX);
    if byte_size > MAXIMUM_APPLICATION_HISTORY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "application history exceeds the private storage budget",
        ));
    }
    // Reject malformed payloads before atomically replacing the last good copy.
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(2)
        || !value
            .get("applications")
            .is_some_and(serde_json::Value::is_array)
        || !value.get("points").is_some_and(serde_json::Value::is_array)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "application history does not match schema version 2",
        ));
    }
    private_storage::write_atomic(path, payload.as_bytes())?;
    Ok(ApplicationHistoryStorage {
        payload: None,
        byte_size,
        updated_at_ms: Some(now_millis()),
    })
}

pub fn remove(path: &Path) -> io::Result<()> {
    private_storage::remove(path)
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{load, remove, save};

    #[test]
    fn atomically_round_trips_and_removes_application_history() {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("nested/application-impact-history-v2.json");

        assert!(load(&path).unwrap().payload.is_none());
        let saved = save(&path, r#"{"version":2,"applications":[],"points":[]}"#).unwrap();
        assert!(saved.byte_size > 0);
        assert!(saved.updated_at_ms.is_some());
        assert_eq!(
            load(&path).unwrap().payload.as_deref(),
            Some(r#"{"version":2,"applications":[],"points":[]}"#),
        );
        remove(&path).unwrap();
        assert!(load(&path).unwrap().payload.is_none());
    }

    #[test]
    fn invalid_json_does_not_replace_the_last_good_copy() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("application-impact-history-v2.json");
        let valid = r#"{"version":2,"applications":[],"points":[]}"#;
        save(&path, valid).unwrap();

        assert!(save(&path, "{").is_err());
        assert!(save(&path, r#"{"version":1,"points":[]}"#).is_err());
        assert_eq!(load(&path).unwrap().payload.as_deref(), Some(valid));
    }
}
