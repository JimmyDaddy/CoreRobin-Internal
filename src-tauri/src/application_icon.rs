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

#[cfg(target_os = "macos")]
fn load_macos_application_icon(executable: &str) -> Option<ApplicationIcon> {
    let executable = fs::canonicalize(executable).ok()?;
    let bundle = outermost_app_bundle(&executable)?;
    let icon = bundle_icon_path(&bundle)?;
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
fn bundle_icon_path(bundle: &Path) -> Option<PathBuf> {
    let canonical_bundle = fs::canonicalize(bundle).ok()?;
    let resources = canonical_bundle.join("Contents/Resources");
    let plist = plist::Value::from_file(canonical_bundle.join("Contents/Info.plist")).ok();
    let named_icon = plist
        .as_ref()
        .and_then(plist::Value::as_dictionary)
        .and_then(|dictionary| {
            dictionary
                .get("CFBundleIconFile")
                .or_else(|| dictionary.get("CFBundleIconName"))
        })
        .and_then(plist::Value::as_string)
        .map(|name| {
            let name = PathBuf::from(name);
            if name.extension().is_some() {
                name
            } else {
                name.with_extension("icns")
            }
        });
    let candidate = named_icon
        .map(|name| resources.join(name))
        .filter(|path| path.is_file())
        .or_else(|| first_icns_file(&resources))?;
    let candidate = fs::canonicalize(candidate).ok()?;
    candidate
        .starts_with(&canonical_bundle)
        .then_some(candidate)
}

#[cfg(target_os = "macos")]
fn first_icns_file(resources: &Path) -> Option<PathBuf> {
    let mut icons = fs::read_dir(resources)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("icns"))
        })
        .collect::<Vec<_>>();
    icons.sort();
    icons.into_iter().next()
}

#[cfg(target_os = "macos")]
fn temporary_icon_output() -> Option<(TemporaryIconDirectory, PathBuf)> {
    for _ in 0..64 {
        let sequence = NEXT_ICON_ID.fetch_add(1, Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("pulse-app-icon-{}-{sequence}", std::process::id(),));
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
    use super::{bundle_icon_path, outermost_app_bundle};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn resolves_the_declared_bundle_icon_without_leaving_the_bundle() {
        let root = std::env::temp_dir().join(format!(
            "pulse-icon-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        ));
        let bundle = root.join("Example.app");
        let resources = bundle.join("Contents/Resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(
            bundle.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIconFile</key><string>PulseIcon</string></dict></plist>"#,
        )
        .unwrap();
        fs::write(resources.join("PulseIcon.icns"), b"test").unwrap();

        assert_eq!(
            bundle_icon_path(&bundle).as_deref(),
            fs::canonicalize(resources.join("PulseIcon.icns"))
                .ok()
                .as_deref(),
        );
        fs::remove_dir_all(root).unwrap();
    }
}
