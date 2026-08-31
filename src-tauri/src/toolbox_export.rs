use std::fs::{OpenOptions, create_dir_all, rename};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CommandError;

const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextExportRequest {
    pub path: String,
    pub content: String,
}

pub fn write_text_copy(request: TextExportRequest) -> Result<(), CommandError> {
    if request.content.len() > MAX_TEXT_BYTES {
        return Err(CommandError::new(
            "output_too_large",
            "The export exceeds the 4 MiB limit.",
        ));
    }
    let target = validate_target(&request.path)?;
    if target.exists() {
        return Err(CommandError::new(
            "target_exists",
            "Choose a new filename; existing files are never overwritten.",
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| CommandError::new("invalid_target", "The export location is invalid."))?;
    create_dir_all(parent).map_err(|_| {
        CommandError::new("export_failed", "The export folder could not be prepared.")
    })?;
    let temporary = parent.join(format!(".corerobin-export-{}", now_millis()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| {
            CommandError::new(
                "export_failed",
                "The temporary export could not be created.",
            )
        })?;
    if let Err(error) = file
        .write_all(request.content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(CommandError::new(
            "export_failed",
            format!("The export could not be written: {error}"),
        ));
    }
    if target.exists() {
        let _ = std::fs::remove_file(&temporary);
        return Err(CommandError::new(
            "target_exists",
            "Choose a new filename; existing files are never overwritten.",
        ));
    }
    rename(&temporary, &target).map_err(|_| {
        let _ = std::fs::remove_file(&temporary);
        CommandError::new("export_failed", "The export could not be finalized safely.")
    })
}

fn validate_target(raw: &str) -> Result<PathBuf, CommandError> {
    let path = Path::new(raw);
    if raw.trim().is_empty() || !path.is_absolute() || path.file_name().is_none() {
        return Err(CommandError::new(
            "invalid_target",
            "Choose an absolute file path.",
        ));
    }
    if path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
    {
        return Err(CommandError::new(
            "invalid_target",
            "Hidden export filenames are not supported.",
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(CommandError::new(
            "invalid_target",
            "The export path may not contain parent traversal.",
        ));
    }
    if path.exists()
        && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(CommandError::new(
            "invalid_target",
            "The export target may not be a symbolic link.",
        ));
    }
    Ok(path.to_path_buf())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
