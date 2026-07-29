use std::env;
use std::fs;
#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;

use crate::bounded_command;
use crate::error::CommandError;

const USER_ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const USER_ACTION_OUTPUT_LIMIT: usize = 256 * 1_024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemSettingsDestination {
    LoginItems,
    Battery,
    Network,
    Notifications,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProductPage {
    Releases,
    Guide,
    Privacy,
    Issues,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProductLanguage {
    #[serde(rename = "zh-CN")]
    ZhCn,
    En,
    #[serde(rename = "zh-Hant")]
    ZhHant,
    Ja,
    De,
    Fr,
    Es,
    #[serde(rename = "pt-BR")]
    PtBr,
    Ko,
    Ru,
}

pub fn open_product_page(page: ProductPage, language: ProductLanguage) -> Result<(), CommandError> {
    let url = product_page_url(page, language);
    open_external_url(&url)
}

pub fn open_product_issue(title: &str, body: &str) -> Result<(), CommandError> {
    if title.chars().count() > 200 || body.chars().count() > 12_000 {
        return Err(CommandError::new(
            "issue_prefill_too_large",
            "The issue prefill is too large to open safely.",
        ));
    }
    let url = format!(
        "https://github.com/JimmyDaddy/corerobin-monitor/issues/new?title={}&body={}",
        percent_encode_query(title),
        percent_encode_query(body),
    );
    open_external_url(&url)
}

fn open_external_url(url: &str) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    return run_command(
        Command::new("/usr/bin/open").arg(url),
        "The product page could not be opened.",
    );

    #[cfg(windows)]
    return run_command(
        Command::new("explorer.exe").arg(url),
        "The product page could not be opened.",
    );

    #[cfg(target_os = "linux")]
    {
        run_command(
            Command::new("xdg-open").arg(url),
            "The product page could not be opened.",
        )
    }
}

fn percent_encode_query(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn product_page_url(page: ProductPage, language: ProductLanguage) -> String {
    if page == ProductPage::Issues {
        return "https://github.com/JimmyDaddy/corerobin-monitor/issues/new/choose".to_string();
    }
    let page = match page {
        ProductPage::Releases => "releases",
        ProductPage::Guide => "guide",
        ProductPage::Privacy => "privacy",
        ProductPage::Issues => unreachable!(),
    };
    let language = match language {
        ProductLanguage::ZhCn => "",
        ProductLanguage::En => "en/",
        ProductLanguage::ZhHant => "zh-hant/",
        ProductLanguage::Ja => "ja/",
        ProductLanguage::De => "de/",
        ProductLanguage::Fr => "fr/",
        ProductLanguage::Es => "es/",
        ProductLanguage::PtBr => "pt-br/",
        ProductLanguage::Ko => "ko/",
        ProductLanguage::Ru => "ru/",
    };
    format!("https://monitor-app.corerobin.com/{language}{page}/")
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

pub fn resolve_user_path(path: &str) -> Result<PathBuf, CommandError> {
    let path = if path == "~" {
        user_home_directory()?
    } else if let Some(relative) = path.strip_prefix("~/") {
        user_home_directory()?.join(relative)
    } else {
        PathBuf::from(path)
    };
    if !path.is_absolute() {
        return Err(CommandError::new(
            "path_not_absolute",
            "CoreRobin could not resolve this filesystem path.",
        ));
    }
    Ok(path)
}

pub fn eject_removable_volume(mount_point: &str) -> Result<(), CommandError> {
    let mount_point = existing_absolute_path(mount_point)?;

    #[cfg(target_os = "macos")]
    {
        let target = macos_eject_target(&mount_point)?;
        run_bounded_command(
            Command::new("/usr/sbin/diskutil").arg("eject").arg(target),
            "macOS could not eject this volume.",
        )
    }

    #[cfg(target_os = "linux")]
    return run_bounded_command(
        Command::new("umount").arg("--").arg(&mount_point),
        "Linux could not unmount this volume.",
    );

    #[cfg(windows)]
    return run_bounded_command(
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$drive=$env:CORE_ROBIN_EJECT_MOUNT; (New-Object -ComObject Shell.Application).Namespace(17).ParseName($drive).InvokeVerb('Eject')",
            ])
            .env("CORE_ROBIN_EJECT_MOUNT", mount_point.as_os_str()),
        "Windows could not eject this volume.",
    );
}

#[cfg(target_os = "macos")]
fn macos_eject_target(mount_point: &Path) -> Result<String, CommandError> {
    use plist::Value;

    let output = bounded_command::output(
        Command::new("/usr/sbin/diskutil")
            .args(["info", "-plist"])
            .arg(mount_point),
        USER_ACTION_TIMEOUT,
        USER_ACTION_OUTPUT_LIMIT,
    )
    .map_err(|error| command_io_error("macOS could not inspect this volume.", error))?;
    if !output.status.success() {
        return Err(command_status_error(
            "macOS could not inspect this volume.",
            &output.stderr,
        ));
    }
    let value = Value::from_reader_xml(output.stdout.as_slice()).map_err(|error| {
        CommandError::new(
            "volume_eject_failed",
            format!("macOS returned invalid volume information. {error}"),
        )
    })?;
    macos_eject_target_from_plist(&value)
}

#[cfg(target_os = "macos")]
fn macos_eject_target_from_plist(value: &plist::Value) -> Result<String, CommandError> {
    use plist::Value;

    let dictionary = value.as_dictionary().ok_or_else(|| {
        CommandError::new(
            "volume_eject_failed",
            "macOS returned invalid volume information.",
        )
    })?;
    let ejectable = dictionary
        .get("Ejectable")
        .and_then(Value::as_boolean)
        .unwrap_or(false);
    if !ejectable {
        return Err(CommandError::new(
            "volume_not_removable",
            "macOS no longer reports this volume as ejectable.",
        ));
    }
    let identifier = dictionary
        .get("ParentWholeDisk")
        .or_else(|| dictionary.get("DeviceIdentifier"))
        .and_then(Value::as_string)
        .ok_or_else(|| {
            CommandError::new(
                "volume_eject_failed",
                "macOS did not provide a device identifier for this volume.",
            )
        })?;
    if !valid_macos_disk_identifier(identifier) {
        return Err(CommandError::new(
            "volume_eject_failed",
            "macOS returned an invalid device identifier for this volume.",
        ));
    }
    Ok(identifier.to_owned())
}

#[cfg(target_os = "macos")]
fn valid_macos_disk_identifier(identifier: &str) -> bool {
    let Some(suffix) = identifier.strip_prefix("disk") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.split_once('s').map_or_else(
            || suffix.chars().all(|character| character.is_ascii_digit()),
            |(disk, partition)| {
                !disk.is_empty()
                    && !partition.is_empty()
                    && disk.chars().all(|character| character.is_ascii_digit())
                    && partition
                        .chars()
                        .all(|character| character.is_ascii_digit())
            },
        )
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

pub fn open_disk_utility() -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    return run_command(
        Command::new("/usr/bin/open").args(["-a", "Disk Utility"]),
        "Disk Utility could not be opened.",
    );

    #[cfg(windows)]
    return run_command(
        &mut Command::new("diskmgmt.msc"),
        "Disk Management could not be opened.",
    );

    #[cfg(target_os = "linux")]
    {
        spawn_and_reap(
            Command::new("gnome-disks")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
            "The system disk utility could not be opened.",
        )
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
    let path = resolve_user_path(path)?;
    fs::symlink_metadata(&path).map_err(|error| {
        CommandError::new(
            "path_unavailable",
            format!("This item is no longer available: {error}"),
        )
    })?;
    Ok(path)
}

fn user_home_directory() -> Result<PathBuf, CommandError> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })
}

#[cfg(any(target_os = "macos", test))]
fn application_bundle_from_path(path: &std::path::Path) -> Option<PathBuf> {
    path.ancestors()
        .filter(|ancestor| {
            ancestor
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .last()
        .map(std::path::Path::to_path_buf)
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

fn run_bounded_command(command: &mut Command, failure_message: &str) -> Result<(), CommandError> {
    let output = bounded_command::output(command, USER_ACTION_TIMEOUT, USER_ACTION_OUTPUT_LIMIT)
        .map_err(|error| command_io_error(failure_message, error))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_status_error(failure_message, &output.stderr))
    }
}

fn command_io_error(failure_message: &str, error: std::io::Error) -> CommandError {
    let code = if error.kind() == std::io::ErrorKind::TimedOut {
        "volume_eject_timeout"
    } else {
        "volume_eject_failed"
    };
    CommandError::new(code, format!("{failure_message} {error}"))
}

fn command_status_error(failure_message: &str, stderr: &[u8]) -> CommandError {
    let detail = String::from_utf8_lossy(stderr).trim().to_owned();
    let code = if detail.to_ascii_lowercase().contains("busy") {
        "volume_busy"
    } else {
        "volume_eject_failed"
    };
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!(" {detail}")
    };
    CommandError::new(code, format!("{failure_message}{detail}"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
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
        SystemSettingsDestination::Notifications => {
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        }
    }
}

#[cfg(windows)]
fn windows_settings_uri(destination: SystemSettingsDestination) -> &'static str {
    match destination {
        SystemSettingsDestination::LoginItems => "ms-settings:startupapps",
        SystemSettingsDestination::Battery => "ms-settings:batterysaver",
        SystemSettingsDestination::Network => "ms-settings:network-status",
        SystemSettingsDestination::Notifications => "ms-settings:notifications",
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        ProductLanguage, ProductPage, application_bundle_from_path, percent_encode_query,
        product_page_url, resolve_user_path,
    };
    #[cfg(target_os = "macos")]
    use super::{macos_eject_target_from_plist, valid_macos_disk_identifier};

    #[test]
    fn product_pages_are_fixed_to_public_corerobin_destinations() {
        assert_eq!(
            product_page_url(ProductPage::Releases, ProductLanguage::ZhCn),
            "https://monitor-app.corerobin.com/releases/"
        );
        assert_eq!(
            product_page_url(ProductPage::Privacy, ProductLanguage::Ja),
            "https://monitor-app.corerobin.com/ja/privacy/"
        );
        assert_eq!(
            product_page_url(ProductPage::Guide, ProductLanguage::PtBr),
            "https://monitor-app.corerobin.com/pt-br/guide/"
        );
    }

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
    fn issue_prefill_is_encoded_as_query_data() {
        assert_eq!(
            percent_encode_query("CoreRobin issue\n版本"),
            "CoreRobin%20issue%0A%E7%89%88%E6%9C%AC",
        );
    }

    #[test]
    fn rejects_paths_without_an_application_bundle() {
        assert_eq!(
            application_bundle_from_path(Path::new("/usr/bin/example")),
            None
        );
    }

    #[test]
    fn expands_current_user_display_paths_before_file_actions() {
        let resolved = resolve_user_path("~/Documents/example.txt").unwrap();
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("Documents/example.txt"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_only_diskutil_device_identifiers() {
        assert!(valid_macos_disk_identifier("disk4"));
        assert!(valid_macos_disk_identifier("disk12s3"));
        assert!(!valid_macos_disk_identifier("/dev/disk4"));
        assert!(!valid_macos_disk_identifier("disk"));
        assert!(!valid_macos_disk_identifier("disk4;reboot"));
        assert!(!valid_macos_disk_identifier("rdisk4"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ejects_the_parent_device_instead_of_only_the_mounted_partition() {
        let mut dictionary = plist::Dictionary::new();
        dictionary.insert("Ejectable".to_owned(), plist::Value::Boolean(true));
        dictionary.insert(
            "DeviceIdentifier".to_owned(),
            plist::Value::String("disk12s1".to_owned()),
        );
        dictionary.insert(
            "ParentWholeDisk".to_owned(),
            plist::Value::String("disk12".to_owned()),
        );
        assert_eq!(
            macos_eject_target_from_plist(&plist::Value::Dictionary(dictionary)).unwrap(),
            "disk12"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_a_volume_that_is_no_longer_ejectable() {
        let mut dictionary = plist::Dictionary::new();
        dictionary.insert("Ejectable".to_owned(), plist::Value::Boolean(false));
        dictionary.insert(
            "DeviceIdentifier".to_owned(),
            plist::Value::String("disk12s1".to_owned()),
        );
        let error =
            macos_eject_target_from_plist(&plist::Value::Dictionary(dictionary)).unwrap_err();
        assert_eq!(error.code, "volume_not_removable");
    }
}
