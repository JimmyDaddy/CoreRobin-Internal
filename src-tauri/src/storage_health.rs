use std::process::Command;

use serde::Serialize;

use crate::error::CommandError;

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
) -> StorageHealthSnapshot {
    StorageHealthSnapshot {
        sampled_at_ms,
        devices: mount_points
            .iter()
            .map(|mount_point| inspect_mount_point(mount_point))
            .collect(),
    }
}

#[cfg(target_os = "macos")]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    use plist::Value;

    let output = Command::new("/usr/sbin/diskutil")
        .args(["info", "-plist", mount_point])
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return unavailable_device(mount_point, String::from_utf8_lossy(&output.stderr).trim());
        }
        Err(error) => return unavailable_device(mount_point, &error.to_string()),
    };
    let value = match Value::from_reader_xml(output.stdout.as_slice()) {
        Ok(value) => value,
        Err(error) => return unavailable_device(mount_point, &error.to_string()),
    };
    let Some(dictionary) = value.as_dictionary() else {
        return unavailable_device(mount_point, "diskutil returned an invalid property list.");
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
    }
}

#[cfg(target_os = "linux")]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    let output = Command::new("findmnt")
        .args([
            "--json",
            "--output",
            "FSTYPE,OPTIONS,SOURCE",
            "--target",
            mount_point,
        ])
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return unavailable_device(mount_point, String::from_utf8_lossy(&output.stderr).trim());
        }
        Err(error) => return unavailable_device(mount_point, &error.to_string()),
    };
    let value: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => return unavailable_device(mount_point, &error.to_string()),
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
    }
}

#[cfg(windows)]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$drive=(Split-Path -Qualifier $env:CORE_ROBIN_VOLUME_PATH).TrimEnd(':'); Get-Volume -DriveLetter $drive | Select-Object FileSystemType,Path,HealthStatus,DriveType,SizeRemaining | ConvertTo-Json -Compress",
        ])
        .env("CORE_ROBIN_VOLUME_PATH", mount_point)
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return unavailable_device(mount_point, String::from_utf8_lossy(&output.stderr).trim());
        }
        Err(error) => return unavailable_device(mount_point, &error.to_string()),
    };
    let value: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => return unavailable_device(mount_point, &error.to_string()),
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
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn inspect_mount_point(mount_point: &str) -> StorageDeviceHealth {
    unavailable_device(
        mount_point,
        "Storage health inspection is unavailable on this platform.",
    )
}

fn unavailable_device(mount_point: &str, error: &str) -> StorageDeviceHealth {
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
