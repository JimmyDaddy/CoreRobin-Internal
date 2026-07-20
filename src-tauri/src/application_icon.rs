#[cfg(target_os = "macos")]
use crate::application_metadata::bundle_icon_path;
use crate::models::ApplicationIcon;

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
const MAX_ICON_BYTES: usize = 1_048_576;
#[cfg(target_os = "macos")]
static NEXT_ICON_ID: AtomicU64 = AtomicU64::new(1);

pub fn load_application_icon(executable: Option<&str>) -> Option<ApplicationIcon> {
    #[cfg(target_os = "macos")]
    {
        load_macos_application_icon(executable?)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = executable;
        None
    }
}

pub fn load_application_bundle_icon(application_path: &str) -> Option<ApplicationIcon> {
    #[cfg(target_os = "macos")]
    {
        let bundle = fs::canonicalize(application_path).ok()?;
        load_macos_bundle_icon(&bundle)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = application_path;
        None
    }
}

#[cfg(target_os = "macos")]
fn load_macos_application_icon(executable: &str) -> Option<ApplicationIcon> {
    let executable = fs::canonicalize(executable).ok()?;
    let bundle = outermost_app_bundle(&executable)?;
    load_macos_bundle_icon(&bundle)
}

#[cfg(target_os = "macos")]
fn load_macos_bundle_icon(bundle: &Path) -> Option<ApplicationIcon> {
    let icon = bundle_icon_path(bundle)?;
    let (_cleanup, output) = temporary_icon_output()?;
    let converted = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-Z", "96"])
        .arg(&icon)
        .arg("--out")
        .arg(&output)
        .output()
        .ok()?;
    if !converted.status.success() {
        return None;
    }
    let bytes = fs::read(output).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        return None;
    }
    Some(ApplicationIcon {
        mime_type: "image/png".to_owned(),
        bytes,
    })
}

#[cfg(target_os = "macos")]
fn outermost_app_bundle(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .last()
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn temporary_icon_output() -> Option<(TemporaryIconDirectory, PathBuf)> {
    for _ in 0..64 {
        let sequence = NEXT_ICON_ID.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "core-robin-app-icon-{}-{sequence}",
            std::process::id(),
        ));
        match fs::create_dir(&directory) {
            Ok(()) => {
                if fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).is_err() {
                    let _ = fs::remove_dir(&directory);
                    return None;
                }
                let output = directory.join("icon.png");
                return Some((TemporaryIconDirectory(directory), output));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

#[cfg(target_os = "macos")]
struct TemporaryIconDirectory(PathBuf);

#[cfg(target_os = "macos")]
impl Drop for TemporaryIconDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::outermost_app_bundle;
    use std::path::Path;

    #[test]
    fn chooses_the_outer_application_bundle_for_helper_processes() {
        let executable = Path::new(
            "/Applications/Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
        );
        assert_eq!(
            outermost_app_bundle(executable).as_deref(),
            Some(Path::new("/Applications/Code.app")),
        );
    }
}
