use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::CommandError;

const MAX_EXPORT_BYTES: usize = 16 * 1_024 * 1_024;

pub fn write(path: &str, content: &str) -> Result<(), CommandError> {
    if content.len() > MAX_EXPORT_BYTES {
        return Err(CommandError::new(
            "history_export_too_large",
            "The selected history is too large to export in one file.",
        ));
    }
    let path = validated_export_path(path)?;
    if matches!(fs::symlink_metadata(&path), Ok(metadata) if metadata.file_type().is_symlink()) {
        return Err(CommandError::new(
            "history_export_symlink",
            "Choose a regular file instead of a symbolic link.",
        ));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)
        .map_err(|error| {
            CommandError::new(
                "history_export_write_failed",
                format!("CoreRobin could not create the export file: {error}"),
            )
        })?;
    file.write_all(content.as_bytes()).map_err(|error| {
        CommandError::new(
            "history_export_write_failed",
            format!("CoreRobin could not write the export file: {error}"),
        )
    })?;
    file.sync_all().map_err(|error| {
        CommandError::new(
            "history_export_write_failed",
            format!("CoreRobin could not finish the export file: {error}"),
        )
    })
}

fn validated_export_path(path: &str) -> Result<PathBuf, CommandError> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(CommandError::new(
            "history_export_path_invalid",
            "Choose an absolute destination for the export.",
        ));
    }
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !matches!(extension.to_ascii_lowercase().as_str(), "json" | "csv") {
        return Err(CommandError::new(
            "history_export_format_invalid",
            "History exports must use a .json or .csv file.",
        ));
    }
    let parent = candidate.parent().ok_or_else(|| {
        CommandError::new(
            "history_export_path_invalid",
            "The selected destination has no parent folder.",
        )
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        CommandError::new(
            "history_export_path_invalid",
            format!("The selected destination is unavailable: {error}"),
        )
    })?;
    let file_name = candidate.file_name().ok_or_else(|| {
        CommandError::new(
            "history_export_path_invalid",
            "Choose a file name for the export.",
        )
    })?;
    Ok(canonical_parent.join(file_name))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::write;

    #[test]
    fn writes_json_and_csv_to_a_selected_folder() {
        let root = tempdir().unwrap();
        let json = root.path().join("history.json");
        let csv = root.path().join("history.csv");

        write(json.to_str().unwrap(), "{\"version\":1}").unwrap();
        write(csv.to_str().unwrap(), "time,value\n1,2").unwrap();

        assert_eq!(fs::read_to_string(json).unwrap(), "{\"version\":1}");
        assert_eq!(fs::read_to_string(csv).unwrap(), "time,value\n1,2");
    }

    #[test]
    fn rejects_relative_or_unrelated_extensions() {
        assert_eq!(
            write("history.json", "{}").unwrap_err().code,
            "history_export_path_invalid"
        );
        let root = tempdir().unwrap();
        assert_eq!(
            write(root.path().join("history.txt").to_str().unwrap(), "x")
                .unwrap_err()
                .code,
            "history_export_format_invalid"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_an_existing_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let target = root.path().join("target.json");
        let link = root.path().join("history.json");
        fs::write(&target, "unchanged").unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(
            write(link.to_str().unwrap(), "{}").unwrap_err().code,
            "history_export_symlink"
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "unchanged");
    }
}
