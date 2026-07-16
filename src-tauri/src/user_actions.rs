use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::process::Stdio;

use serde::Deserialize;

use crate::error::CommandError;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemSettingsDestination {
    LoginItems,
    Battery,
    Network,
}

pub fn reveal_path(path: &str) -> Result<(), CommandError> {
    let path = existing_absolute_path(path)?;

    #[cfg(target_os = "macos")]
    return run_command(
        Command::new("/usr/bin/open").arg("-R").arg(path),
        "Finder could not reveal this item.",
    );

    #[cfg(windows)]
    return run_command(
        Command::new("explorer.exe").arg(format!("/select,{}", path.display())),
        "File Explorer could not reveal this item.",
    );

    #[cfg(target_os = "linux")]
    {
        let target = if path.is_dir() {
            path.as_path()
        } else {
            path.parent().unwrap_or(path.as_path())
        };
        run_command(
            Command::new("xdg-open").arg(target),
            "The file manager could not open this location.",
        )
    }
}

pub fn preview_path(path: &str) -> Result<(), CommandError> {
    let path = existing_absolute_path(path)?;

    #[cfg(target_os = "macos")]
    return spawn_and_reap(
        Command::new("/usr/bin/qlmanage")
            .arg("-p")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        "Quick Look could not preview this item.",
    );

    #[cfg(windows)]
    return run_command(
        Command::new("explorer.exe").arg(path),
        "Windows could not open this item.",
    );

    #[cfg(target_os = "linux")]
    {
        run_command(
            Command::new("xdg-open").arg(path),
            "The default application could not open this item.",
        )
    }
}

pub fn open_system_settings(destination: SystemSettingsDestination) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    return run_command(
        Command::new("/usr/bin/open").arg(macos_settings_uri(destination)),
        "System Settings could not open the requested page.",
    );

    #[cfg(windows)]
    return run_command(
        Command::new("explorer.exe").arg(windows_settings_uri(destination)),
        "Windows Settings could not open the requested page.",
    );

    #[cfg(target_os = "linux")]
    {
        let _ = destination;
        Err(CommandError::new(
            "system_settings_unavailable",
            "Opening this settings page is not supported on this Linux desktop yet.",
        ))
    }
}

pub fn relaunch_application(executable_path: &str) -> Result<(), CommandError> {
    let executable_path = canonical_existing_path(executable_path)?;

    #[cfg(target_os = "macos")]
    {
        let bundle = validated_application_bundle(&executable_path).ok_or_else(|| {
            CommandError::new(
                "application_bundle_unavailable",
                "This process does not belong to a relaunchable macOS application.",
            )
        })?;
        run_command(
            Command::new("/usr/bin/open").arg(bundle),
            "macOS could not reopen this application.",
        )
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = executable_path;
        Err(CommandError::new(
            "application_relaunch_unavailable",
            "Safe application relaunch is not supported on this platform yet.",
        ))
    }
}

pub fn can_relaunch_application(executable_path: &str) -> Result<bool, CommandError> {
    let executable_path = canonical_existing_path(executable_path)?;

    #[cfg(target_os = "macos")]
    return Ok(validated_application_bundle(&executable_path).is_some());

    #[cfg(not(target_os = "macos"))]
    {
        let _ = executable_path;
        Ok(false)
    }
}

fn canonical_existing_path(path: &str) -> Result<PathBuf, CommandError> {
    let path = existing_absolute_path(path)?;
    fs::canonicalize(path).map_err(|error| {
        CommandError::new(
            "path_unavailable",
            format!("This item is no longer available: {error}"),
        )
    })
}

fn existing_absolute_path(path: &str) -> Result<PathBuf, CommandError> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(CommandError::new(
            "path_not_absolute",
            "Only absolute filesystem paths can be opened.",
        ));
    }
    fs::symlink_metadata(path).map_err(|error| {
        CommandError::new(
            "path_unavailable",
            format!("This item is no longer available: {error}"),
        )
    })?;
    Ok(path.to_path_buf())
}

#[cfg(any(target_os = "macos", test))]
fn application_bundle_from_path(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .filter(|ancestor| {
            ancestor
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .last()
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn validated_application_bundle(path: &Path) -> Option<PathBuf> {
    application_bundle_from_path(path).filter(|bundle| {
        bundle.join("Contents/Info.plist").is_file() && bundle.join("Contents/MacOS").is_dir()
    })
}

fn run_command(command: &mut Command, failure_message: &str) -> Result<(), CommandError> {
    let status = command
        .status()
        .map_err(|error| CommandError::internal(format!("{failure_message} {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(CommandError::internal(format!(
            "{failure_message} The operating system returned {status}."
        )))
    }
}

#[cfg(target_os = "macos")]
fn spawn_and_reap(command: &mut Command, failure_message: &str) -> Result<(), CommandError> {
    let mut child = command
        .spawn()
        .map_err(|error| CommandError::internal(format!("{failure_message} {error}")))?;
    std::thread::Builder::new()
        .name("core-robin-user-action".to_owned())
        .spawn(move || {
            let _ = child.wait();
        })
        .map_err(|error| CommandError::internal(format!("{failure_message} {error}")))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_settings_uri(destination: SystemSettingsDestination) -> &'static str {
    match destination {
        SystemSettingsDestination::LoginItems => {
            "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
        }
        SystemSettingsDestination::Battery => {
            "x-apple.systempreferences:com.apple.Battery-Settings.extension"
        }
        SystemSettingsDestination::Network => {
            "x-apple.systempreferences:com.apple.Network-Settings.extension"
        }
    }
}

#[cfg(windows)]
fn windows_settings_uri(destination: SystemSettingsDestination) -> &'static str {
    match destination {
        SystemSettingsDestination::LoginItems => "ms-settings:startupapps",
        SystemSettingsDestination::Battery => "ms-settings:batterysaver",
        SystemSettingsDestination::Network => "ms-settings:network-status",
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::application_bundle_from_path;

    #[test]
    fn finds_the_outer_application_bundle_for_nested_helpers() {
        let path = Path::new(
            "/Applications/Browser.app/Contents/Frameworks/Browser Helper.app/Contents/MacOS/Helper",
        );
        assert_eq!(
            application_bundle_from_path(path),
            Some(Path::new("/Applications/Browser.app").to_path_buf())
        );
    }

    #[test]
    fn rejects_paths_without_an_application_bundle() {
        assert_eq!(
            application_bundle_from_path(Path::new("/usr/bin/example")),
            None
        );
    }
}
