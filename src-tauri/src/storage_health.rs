use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::bounded_command;
use crate::error::CommandError;

const STORAGE_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const STORAGE_COMMAND_OUTPUT_LIMIT: usize = 512 * 1_024;
const STORAGE_HEALTH_CACHE_TTL_MS: u64 = 10 * 60 * 1_000;
const STORAGE_HEALTH_MAX_CONCURRENCY: usize = 4;

#[derive(Clone)]
struct StorageHealthCacheEntry {
    inspected_at_ms: u64,
    device: StorageDeviceHealth,
}

static STORAGE_HEALTH_CACHE: OnceLock<Mutex<HashMap<String, StorageHealthCacheEntry>>> =
    OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHealthSnapshot {
    pub sampled_at_ms: u64,
    pub devices: Vec<StorageDeviceHealth>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDeviceHealth {
    pub mount_point: String,
    pub filesystem: Option<String>,
    pub source: Option<String>,
    pub smart_status: StorageSmartStatus,
    pub smart_label: Option<String>,
    pub read_only: Option<bool>,
    pub internal: Option<bool>,
    pub solid_state: Option<bool>,
    pub purgeable_bytes: Option<u64>,
    pub inspection_error: Option<String>,
    pub inspected_at_ms: u64,
    pub cached: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageSmartStatus {
    Verified,
    Warning,
    Failing,
    Unsupported,
    Unknown,
}

pub fn inspect_storage_health(
    mount_points: &[String],
    sampled_at_ms: u64,
    force_refresh: bool,
) -> StorageHealthSnapshot {
    let mut devices = Vec::with_capacity(mount_points.len());
    for chunk in mount_points.chunks(STORAGE_HEALTH_MAX_CONCURRENCY) {
        let inspected = std::thread::scope(|scope| {
            chunk
                .iter()
                .map(|mount_point| {
                    (
                        mount_point,
                        scope.spawn(move || {
                            inspect_mount_point_cached(mount_point, sampled_at_ms, force_refresh)
                        }),
                    )
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|(mount_point, worker)| {
                    worker.join().unwrap_or_else(|_| {
                        unavailable_device(
                            mount_point,
                            "Storage inspection worker stopped unexpectedly.",
                            sampled_at_ms,
                        )
                    })
                })
                .collect::<Vec<_>>()
        });
        devices.extend(inspected);
    }
    StorageHealthSnapshot {
        sampled_at_ms,
        devices,
    }
}

fn inspect_mount_point_cached(
    mount_point: &str,
    sampled_at_ms: u64,
    force_refresh: bool,
) -> StorageDeviceHealth {
    let cache = STORAGE_HEALTH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if !force_refresh
        && let Ok(cache) = cache.lock()
        && let Some(entry) = cache.get(mount_point)
        && sampled_at_ms.saturating_sub(entry.inspected_at_ms) <= STORAGE_HEALTH_CACHE_TTL_MS
    {
        let mut device = entry.device.clone();
        device.cached = true;
        return device;
    }
    let mut device = inspect_mount_point(mount_point);
    device.inspected_at_ms = sampled_at_ms;
    device.cached = false;
    if let Ok(mut cache) = cache.lock() {
        cache.insert(
            mount_point.to_owned(),
            StorageHealthCacheEntry {
                inspected_at_ms: sampled_at_ms,
                device: device.clone(),
            },
        );
        cache.retain(|_, entry| {
            sampled_at_ms.saturating_sub(entry.inspected_at_ms) <= STORAGE_HEALTH_CACHE_TTL_MS
        });
    }
    device
}

#[cfg(target_os = "macos")]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    use plist::Value;

    let output = bounded_command::output(
        Command::new("/usr/sbin/diskutil").args(["info", "-plist", mount_point]),
        STORAGE_COMMAND_TIMEOUT,
        STORAGE_COMMAND_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return unavailable_device(
                mount_point,
                String::from_utf8_lossy(&output.stderr).trim(),
                0,
            );
        }
        Err(error) => return unavailable_device(mount_point, &error.to_string(), 0),
    };
    let value = match Value::from_reader_xml(output.stdout.as_slice()) {
        Ok(value) => value,
        Err(error) => return unavailable_device(mount_point, &error.to_string(), 0),
    };
    let Some(dictionary) = value.as_dictionary() else {
        return unavailable_device(
            mount_point,
            "diskutil returned an invalid property list.",
            0,
        );
    };
    let smart_label = dictionary
        .get("SMARTStatus")
        .and_then(Value::as_string)
        .map(str::to_owned);
    let smart_status = classify_smart_status(smart_label.as_deref());
    StorageDeviceHealth {
        mount_point: mount_point.to_owned(),
        filesystem: dictionary
            .get("FilesystemName")
            .or_else(|| dictionary.get("FilesystemType"))
            .and_then(Value::as_string)
            .map(str::to_owned),
        source: dictionary
            .get("DeviceIdentifier")
            .and_then(Value::as_string)
            .map(str::to_owned),
        smart_status,
        smart_label,
        read_only: dictionary.get("VolumeReadOnly").and_then(Value::as_boolean),
        internal: dictionary.get("DeviceInternal").and_then(Value::as_boolean),
        solid_state: dictionary.get("SolidState").and_then(Value::as_boolean),
        purgeable_bytes: dictionary
            .get("APFSPurgeableSpace")
            .or_else(|| dictionary.get("PurgeableSpace"))
            .and_then(plist_unsigned),
        inspection_error: None,
        inspected_at_ms: 0,
        cached: false,
    }
}

#[cfg(target_os = "linux")]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    let output = bounded_command::output(
        Command::new("findmnt").args([
            "--json",
            "--output",
            "FSTYPE,OPTIONS,SOURCE",
            "--target",
            mount_point,
        ]),
        STORAGE_COMMAND_TIMEOUT,
        STORAGE_COMMAND_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return unavailable_device(
                mount_point,
                String::from_utf8_lossy(&output.stderr).trim(),
                0,
            );
        }
        Err(error) => return unavailable_device(mount_point, &error.to_string(), 0),
    };
    let value: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => return unavailable_device(mount_point, &error.to_string(), 0),
    };
    let filesystem = value
        .pointer("/filesystems/0/fstype")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let options = value
        .pointer("/filesystems/0/options")
        .and_then(serde_json::Value::as_str);
    let source = value
        .pointer("/filesystems/0/source")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    StorageDeviceHealth {
        mount_point: mount_point.to_owned(),
        filesystem,
        source,
        smart_status: classify_smart_status(None),
        smart_label: None,
        read_only: options.map(|value| value.split(',').any(|option| option == "ro")),
        internal: None,
        solid_state: None,
        purgeable_bytes: None,
        inspection_error: None,
        inspected_at_ms: 0,
        cached: false,
    }
}

#[cfg(windows)]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    let output = bounded_command::output(
        Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$drive=(Split-Path -Qualifier $env:CORE_ROBIN_VOLUME_PATH).TrimEnd(':'); Get-Volume -DriveLetter $drive | Select-Object FileSystemType,Path,HealthStatus,DriveType,SizeRemaining | ConvertTo-Json -Compress",
        ])
        .env("CORE_ROBIN_VOLUME_PATH", mount_point),
        STORAGE_COMMAND_TIMEOUT,
        STORAGE_COMMAND_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return unavailable_device(
                mount_point,
                String::from_utf8_lossy(&output.stderr).trim(),
                0,
            );
        }
        Err(error) => return unavailable_device(mount_point, &error.to_string(), 0),
    };
    let value: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => return unavailable_device(mount_point, &error.to_string(), 0),
    };
    let smart_label = value
        .get("HealthStatus")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let smart_status = classify_smart_status(smart_label.as_deref());
    StorageDeviceHealth {
        mount_point: mount_point.to_owned(),
        filesystem: value
            .get("FileSystemType")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        source: value
            .get("Path")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        smart_status,
        smart_label,
        read_only: None,
        internal: None,
        solid_state: None,
        purgeable_bytes: None,
        inspection_error: None,
        inspected_at_ms: 0,
        cached: false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    unavailable_device(
        mount_point,
        "Storage health inspection is unavailable on this platform.",
        0,
    )
}

fn unavailable_device(mount_point: &str, error: &str, inspected_at_ms: u64) -> StorageDeviceHealth {
    StorageDeviceHealth {
        mount_point: mount_point.to_owned(),
        filesystem: None,
        source: None,
        smart_status: StorageSmartStatus::Unknown,
        smart_label: None,
        read_only: None,
        internal: None,
        solid_state: None,
        purgeable_bytes: None,
        inspection_error: Some(if error.is_empty() {
            "Storage information is temporarily unavailable.".to_owned()
        } else {
            error.to_owned()
        }),
        inspected_at_ms,
        cached: false,
    }
}

fn classify_smart_status(label: Option<&str>) -> StorageSmartStatus {
    match label.map(str::to_ascii_lowercase) {
        Some(value) if value.contains("fail") || value.contains("unhealthy") => {
            StorageSmartStatus::Failing
        }
        Some(value) if value.contains("warn") => StorageSmartStatus::Warning,
        Some(value) if value.contains("verified") || value == "healthy" => {
            StorageSmartStatus::Verified
        }
        Some(value) if value.contains("not supported") || value.contains("unsupported") => {
            StorageSmartStatus::Unsupported
        }
        Some(_) => StorageSmartStatus::Unknown,
        None => StorageSmartStatus::Unsupported,
    }
}

#[cfg(target_os = "macos")]
fn plist_unsigned(value: &plist::Value) -> Option<u64> {
    value.as_unsigned_integer().or_else(|| {
        value
            .as_signed_integer()
            .and_then(|value| u64::try_from(value).ok())
    })
}

pub fn validate_mount_points(
    requested: &[String],
    available: &[String],
) -> Result<Vec<String>, CommandError> {
    if requested.len() > 64 {
        return Err(CommandError::new(
            "too_many_storage_targets",
            "CoreRobin can inspect at most 64 mounted volumes at once.",
        ));
    }
    let mut verified = Vec::new();
    for mount_point in requested {
        if !available.iter().any(|candidate| candidate == mount_point) {
            return Err(CommandError::new(
                "storage_target_unavailable",
                "A requested volume is no longer mounted.",
            ));
        }
        if !verified.contains(mount_point) {
            verified.push(mount_point.clone());
        }
    }
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::{StorageSmartStatus, classify_smart_status, validate_mount_points};

    #[test]
    fn classifies_platform_health_labels_without_treating_unhealthy_as_healthy() {
        assert!(matches!(
            classify_smart_status(Some("Verified")),
            StorageSmartStatus::Verified
        ));
        assert!(matches!(
            classify_smart_status(Some("Healthy")),
            StorageSmartStatus::Verified
        ));
        assert!(matches!(
            classify_smart_status(Some("Warning")),
            StorageSmartStatus::Warning
        ));
        assert!(matches!(
            classify_smart_status(Some("Unhealthy")),
            StorageSmartStatus::Failing
        ));
        assert!(matches!(
            classify_smart_status(None),
            StorageSmartStatus::Unsupported
        ));
    }

    #[test]
    fn validates_only_current_mount_points_and_deduplicates() {
        let available = vec!["/".to_owned(), "/Volumes/Archive".to_owned()];
        assert_eq!(
            validate_mount_points(&["/".to_owned(), "/".to_owned()], &available,).unwrap(),
            vec!["/".to_owned()],
        );
        assert!(validate_mount_points(&["/Volumes/Missing".to_owned()], &available).is_err(),);
    }
}
