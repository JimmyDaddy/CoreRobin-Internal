use std::io::{Cursor, Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};

use crate::error::CommandError;
use crate::toolbox_inputs::opaque_id;

const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXPORT_BYTES: u64 = 512 * 1024 * 1024;
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextExportRequest {
    pub path: String,
    pub content: String,
}

pub fn write_text_copy(request: TextExportRequest) -> Result<(), CommandError> {
    if request.content.len() > MAX_TEXT_BYTES {
        return Err(error(
            "output_too_large",
            "The export exceeds the 4 MiB limit.",
        ));
    }
    let size = request.content.len() as u64;
    write_reader_copy(
        Path::new(&request.path),
        &mut Cursor::new(request.content.into_bytes()),
        size,
        &AtomicBool::new(false),
        || Ok(()),
    )
}

/// Publishes a complete copy using an atomic no-clobber operation. Unlike a
/// check-then-rename, a concurrently created destination can never be replaced.
/// All writes/removals are relative to the bound parent handle.
pub(crate) fn write_reader_copy(
    target: &Path,
    reader: &mut impl Read,
    size: u64,
    cancel: &AtomicBool,
    before_publish: impl FnOnce() -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    if size > MAX_EXPORT_BYTES {
        return Err(error(
            "output_too_large",
            "The export exceeds the temporary output budget.",
        ));
    }
    if !target.is_absolute()
        || target
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(error(
            "invalid_target",
            "Choose an absolute destination without parent traversal.",
        ));
    }
    let name = target
        .file_name()
        .filter(|name| !name.to_string_lossy().starts_with('.'))
        .ok_or_else(|| error("invalid_target", "Choose a visible filename."))?;
    let original_parent = target
        .parent()
        .ok_or_else(|| error("invalid_target", "Choose a destination folder."))?;
    let parent_path = original_parent
        .canonicalize()
        .map_err(|_| error("invalid_target", "The destination folder is unavailable."))?;
    let parent = Dir::open_ambient_dir(&parent_path, ambient_authority()).map_err(|_| failed())?;
    let metadata = parent.dir_metadata().map_err(|_| failed())?;
    let identity = (MetadataExt::dev(&metadata), MetadataExt::ino(&metadata));
    let verify_parent = || {
        let current =
            Dir::open_ambient_dir(original_parent, ambient_authority()).map_err(|_| changed())?;
        let metadata = current.dir_metadata().map_err(|_| changed())?;
        if (MetadataExt::dev(&metadata), MetadataExt::ino(&metadata)) != identity {
            return Err(changed());
        }
        Ok(())
    };
    verify_parent()?;
    ensure_absent(&parent, name)?;
    check_running(cancel, Instant::now())?;
    let temporary = format!(".corerobin-export-{}", opaque_id()?);
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_fs_ext::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = parent
        .open_with(&temporary, &options)
        .map_err(|_| failed())?;
    let started = Instant::now();
    let result = (|| {
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            check_running(cancel, started)?;
            let read = reader.read(&mut buffer).map_err(|_| failed())?;
            if read == 0 {
                break;
            }
            copied = copied.checked_add(read as u64).ok_or_else(failed)?;
            if copied > size {
                return Err(error(
                    "output_changed",
                    "The prepared output changed before export.",
                ));
            }
            file.write_all(&buffer[..read]).map_err(|_| failed())?;
        }
        if copied != size {
            return Err(error(
                "output_changed",
                "The prepared output changed before export.",
            ));
        }
        file.sync_all().map_err(|_| failed())?;
        before_publish()?;
        check_running(cancel, started)?;
        verify_parent()?;
        ensure_absent(&parent, name)?;
        publish_no_replace(&parent, &temporary, name).map_err(|reason| {
            if reason.kind() == std::io::ErrorKind::AlreadyExists {
                exists()
            } else {
                failed()
            }
        })?;
        verify_parent()?;
        Ok(())
    })();
    drop(file);
    let cleanup = parent.remove_file(&temporary);
    if result.is_ok() && cleanup.is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound) {
        return Err(error(
            "cleanup_failed",
            "The copy was saved, but its temporary link could not be removed.",
        ));
    }
    result
}

#[cfg(target_os = "macos")]
fn publish_no_replace(
    parent: &Dir,
    temporary: &str,
    name: &std::ffi::OsStr,
) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(temporary).map_err(std::io::Error::other)?;
    let destination = CString::new(name.as_bytes()).map_err(std::io::Error::other)?;
    // Kernel-enforced EXCL also works on removable filesystems without hard links.
    let result = unsafe {
        libc::renameatx_np(
            parent.as_raw_fd(),
            source.as_ptr(),
            parent.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn publish_no_replace(
    parent: &Dir,
    temporary: &str,
    name: &std::ffi::OsStr,
) -> std::io::Result<()> {
    parent.hard_link(temporary, parent, name)
}

fn ensure_absent(parent: &Dir, name: &std::ffi::OsStr) -> Result<(), CommandError> {
    match parent.symlink_metadata(name) {
        Ok(_) => Err(exists()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(failed()),
    }
}

fn check_running(cancel: &AtomicBool, started: Instant) -> Result<(), CommandError> {
    if cancel.load(Ordering::Acquire) {
        return Err(error("cancelled", "The export was cancelled."));
    }
    if started.elapsed() > EXPORT_TIMEOUT {
        return Err(error(
            "export_timeout",
            "The export exceeded its time limit.",
        ));
    }
    Ok(())
}

fn error(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message)
}
fn exists() -> CommandError {
    error(
        "target_exists",
        "Choose a new filename; existing entries are never overwritten.",
    )
}
fn failed() -> CommandError {
    error(
        "export_failed",
        "The copy could not be saved safely. Check the destination and available space.",
    )
}
fn changed() -> CommandError {
    error(
        "target_changed",
        "The destination folder changed; select it again.",
    )
}

#[cfg(test)]
#[path = "toolbox_export_tests.rs"]
mod tests;
