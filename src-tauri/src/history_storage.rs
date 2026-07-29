use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::private_storage;

pub const HISTORY_DIRECTORY_NAME: &str = "history";
const MAXIMUM_SEGMENT_BYTES: u64 = 16 * 1_024 * 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryCategory {
    Resource,
    ResourceAlerts,
    NetworkQuality,
    Connections,
    UserActions,
    ApplicationWatch,
    StartupImpact,
    CleanupScans,
}

impl HistoryCategory {
    pub const ALL: [Self; 8] = [
        Self::Resource,
        Self::ResourceAlerts,
        Self::NetworkQuality,
        Self::Connections,
        Self::UserActions,
        Self::ApplicationWatch,
        Self::StartupImpact,
        Self::CleanupScans,
    ];

    pub fn parse(value: &str) -> io::Result<Self> {
        match value {
            "resource" => Ok(Self::Resource),
            "resource-alerts" => Ok(Self::ResourceAlerts),
            "network-quality" => Ok(Self::NetworkQuality),
            "connections" => Ok(Self::Connections),
            "user-actions" => Ok(Self::UserActions),
            "application-watch" => Ok(Self::ApplicationWatch),
            "startup-impact" => Ok(Self::StartupImpact),
            "cleanup-scans" => Ok(Self::CleanupScans),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown history category",
            )),
        }
    }

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Resource => "resource-v1.json",
            Self::ResourceAlerts => "resource-alerts-v1.json",
            Self::NetworkQuality => "network-quality-v1.json",
            Self::Connections => "connections-v1.json",
            Self::UserActions => "user-actions-v1.json",
            Self::ApplicationWatch => "application-watch-v1.json",
            Self::StartupImpact => "startup-impact-v1.json",
            Self::CleanupScans => "cleanup-scans-v1.json",
        }
    }

    pub fn path(self, app_data_dir: &Path) -> PathBuf {
        app_data_dir
            .join(HISTORY_DIRECTORY_NAME)
            .join(self.file_name())
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySegmentStorage {
    pub payload: Option<String>,
    pub byte_size: u64,
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStorageSummary {
    pub byte_size: u64,
    pub file_count: u64,
    pub updated_at_ms: Option<u64>,
}

pub fn load(path: &Path) -> io::Result<HistorySegmentStorage> {
    let Some(bytes) = private_storage::read_limited(path, MAXIMUM_SEGMENT_BYTES)? else {
        return Ok(HistorySegmentStorage::default());
    };
    let payload = String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "history is not UTF-8"))?;
    validate_payload(&payload)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "history segment is not a regular file",
        ));
    }
    Ok(HistorySegmentStorage {
        byte_size: metadata.len(),
        updated_at_ms: metadata.modified().ok().and_then(system_time_millis),
        payload: Some(payload),
    })
}

pub fn save(path: &Path, payload: &str) -> io::Result<HistorySegmentStorage> {
    let byte_size = u64::try_from(payload.len()).unwrap_or(u64::MAX);
    if byte_size > MAXIMUM_SEGMENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "history segment exceeds the private storage budget",
        ));
    }
    validate_payload(payload)?;
    private_storage::write_atomic(path, payload.as_bytes())?;
    Ok(HistorySegmentStorage {
        payload: None,
        byte_size,
        updated_at_ms: Some(now_millis()),
    })
}

pub fn remove(path: &Path) -> io::Result<HistorySegmentStorage> {
    private_storage::remove(path)?;
    // Return a verified receipt instead of relying on the caller's optimistic
    // state. `read_limited` also rejects a replacement symlink or directory.
    let storage = load(path)?;
    if storage.payload.is_some() {
        return Err(io::Error::other(
            "history segment still exists after removal",
        ));
    }
    Ok(storage)
}

pub fn summary(app_data_dir: &Path) -> HistoryStorageSummary {
    let mut summary = HistoryStorageSummary::default();
    for category in HistoryCategory::ALL {
        let path = category.path(app_data_dir);
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_file() => metadata,
            _ => continue,
        };
        summary.byte_size = summary.byte_size.saturating_add(metadata.len());
        summary.file_count = summary.file_count.saturating_add(1);
        summary.updated_at_ms = latest_time(
            summary.updated_at_ms,
            metadata.modified().ok().and_then(system_time_millis),
        );
    }
    summary
}

pub fn clear_all(app_data_dir: &Path) -> io::Result<HistoryStorageSummary> {
    for category in HistoryCategory::ALL {
        remove(&category.path(app_data_dir))?;
    }
    Ok(summary(app_data_dir))
}

fn validate_payload(payload: &str) -> io::Result<()> {
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if !value.is_array() && !value.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "history payload must be a JSON array or object",
        ));
    }
    Ok(())
}

fn latest_time(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn now_millis() -> u64 {
    system_time_millis(SystemTime::now()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{HistoryCategory, clear_all, load, save, summary};

    #[test]
    fn stores_categories_in_separate_atomic_segments() {
        let root = tempfile::tempdir().unwrap();
        let resource = HistoryCategory::Resource.path(root.path());
        let network = HistoryCategory::NetworkQuality.path(root.path());
        save(&resource, r#"{"version":1,"points":[]}"#).unwrap();
        save(&network, "[]").unwrap();

        assert!(load(&resource).unwrap().payload.is_some());
        assert_eq!(summary(root.path()).file_count, 2);
        let receipt = clear_all(root.path()).unwrap();
        assert_eq!(receipt.file_count, 0);
        assert_eq!(receipt.byte_size, 0);
    }

    #[test]
    fn rejects_unknown_categories_and_invalid_payloads() {
        assert!(HistoryCategory::parse("../resource").is_err());
        let root = tempfile::tempdir().unwrap();
        let path = HistoryCategory::Resource.path(root.path());
        assert!(save(&path, "\"text\"").is_err());
        assert!(save(&path, "{").is_err());
    }
}
