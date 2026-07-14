use std::env;
use std::fs;
use std::fs::Metadata;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::models::{
    StartupItem, StartupItemScope, StartupItemSource, StartupItemsSnapshot, StartupLaunchKind,
    StartupManagementAction, StartupManagementExecutionRequest, StartupManagementLease,
    StartupManagementLeaseRequest, StartupManagementResult, StartupManagementStatus,
};

const STARTUP_LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_STARTUP_LEASES: usize = 16;
const MAX_STARTUP_FILE_BYTES: u64 = 2 * 1_024 * 1_024;
static NEXT_STARTUP_LEASE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Default)]
pub struct StartupController {
    leases: Vec<StartupLeaseEntry>,
}

#[derive(Debug)]
struct StartupLeaseEntry {
    id: String,
    expires_at: Instant,
    item_id: String,
    action: StartupManagementAction,
    source_path: PathBuf,
    destination_path: PathBuf,
    source_fingerprint: FileFingerprint,
    canonical_home: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileFingerprint {
    length: u64,
    modified_at_ms: Option<u64>,
    content_hash: u64,
}

impl StartupController {
    pub fn create_lease(
        &mut self,
        request: StartupManagementLeaseRequest,
    ) -> Result<StartupManagementLease, CommandError> {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "Pulse could not locate the current user's home directory.",
            )
        })?;
        self.create_lease_for_home(request, &home)
    }

    pub fn release_lease(&mut self, lease_id: &str) {
        if let Some(position) = self.leases.iter().position(|lease| lease.id == lease_id) {
            self.leases.remove(position);
        }
    }

    pub fn execute(
        &mut self,
        request: StartupManagementExecutionRequest,
    ) -> Result<StartupManagementResult, CommandError> {
        let position = self
            .leases
            .iter()
            .position(|lease| lease.id == request.lease_id)
            .ok_or_else(|| {
                CommandError::new(
                    "startup_confirmation_unavailable",
                    "This startup confirmation was already used, cancelled, or expired.",
                )
            })?;
        let lease = self.leases.remove(position);
        if lease.expires_at <= Instant::now() {
            return Err(CommandError::new(
                "startup_confirmation_expired",
                "This startup confirmation expired. Review the item and confirm again.",
            ));
        }
        validate_startup_source(
            &lease.source_path,
            lease.source_fingerprint,
            &lease.canonical_home,
        )?;
        if lease.destination_path.exists() {
            return Err(CommandError::new(
                "startup_destination_conflict",
                "Another startup configuration now exists at the destination. Pulse changed nothing.",
            ));
        }
        let destination_parent = lease.destination_path.parent().ok_or_else(|| {
            CommandError::internal("The startup destination has no parent directory.")
        })?;
        fs::create_dir_all(destination_parent).map_err(|error| {
            CommandError::new(
                "startup_management_failed",
                format!("Pulse could not prepare its reversible startup storage: {error}"),
            )
        })?;
        let canonical_destination_parent = destination_parent.canonicalize().map_err(|error| {
            CommandError::new(
                "startup_management_failed",
                format!("Pulse could not verify the startup destination: {error}"),
            )
        })?;
        if !canonical_destination_parent.starts_with(&lease.canonical_home) {
            return Err(CommandError::new(
                "startup_item_protected",
                "The startup destination is outside the current user's profile. Pulse changed nothing.",
            ));
        }
        move_startup_file_without_overwrite(&lease.source_path, &lease.destination_path)?;
        Ok(StartupManagementResult {
            item_id: lease.item_id,
            enabled: lease.action == StartupManagementAction::Enable,
        })
    }

    fn create_lease_for_home(
        &mut self,
        request: StartupManagementLeaseRequest,
        home: &Path,
    ) -> Result<StartupManagementLease, CommandError> {
        let now = Instant::now();
        self.leases.retain(|lease| lease.expires_at > now);
        if self.leases.len() >= MAX_STARTUP_LEASES {
            return Err(CommandError::new(
                "startup_confirmation_limit",
                "Too many startup confirmations are open. Close one and try again.",
            ));
        }
        let (items, _) = platform_startup_items(home);
        let item = items
            .into_iter()
            .find(|item| item.id == request.item_id)
            .ok_or_else(|| {
                CommandError::new(
                    "startup_item_unavailable",
                    "This startup item is no longer available. Refresh the list and try again.",
                )
            })?;
        if item.management_status != StartupManagementStatus::Available {
            return Err(CommandError::new(
                "startup_item_protected",
                "Pulse only manages recognized third-party startup files in the current user's profile.",
            ));
        }
        let expected_action = if item.enabled {
            StartupManagementAction::Disable
        } else {
            StartupManagementAction::Enable
        };
        if request.action != expected_action {
            return Err(CommandError::new(
                "startup_state_changed",
                "This startup item changed state. Refresh the list before continuing.",
            ));
        }
        let active_path = PathBuf::from(&item.path);
        let disabled_path = disabled_path_for_item(home, &item)?;
        let (source_path, destination_path) = if item.enabled {
            (active_path, disabled_path)
        } else {
            (disabled_path, active_path)
        };
        let canonical_home = home.canonicalize().map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("Pulse could not verify the current user's home directory: {error}"),
            )
        })?;
        let source_fingerprint = startup_file_fingerprint(&source_path, &canonical_home)?;
        if destination_path.exists() {
            return Err(CommandError::new(
                "startup_destination_conflict",
                "Another startup configuration already exists at the destination. Pulse changed nothing.",
            ));
        }
        let id = format!(
            "startup-{}-{}",
            now_millis(),
            NEXT_STARTUP_LEASE_ID.fetch_add(1, Ordering::Relaxed)
        );
        let expires_at = now + STARTUP_LEASE_TTL;
        self.leases.push(StartupLeaseEntry {
            id: id.clone(),
            expires_at,
            item_id: item.id.clone(),
            action: request.action,
            source_path,
            destination_path,
            source_fingerprint,
            canonical_home,
        });
        Ok(StartupManagementLease {
            id,
            item_id: item.id,
            item_name: item.name,
            action: request.action,
            expires_at_ms: now_millis().saturating_add(STARTUP_LEASE_TTL.as_millis() as u64),
        })
    }
}

pub fn scan_startup_items() -> Result<StartupItemsSnapshot, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "Pulse could not locate the current user's home directory.",
        )
    })?;
    let (mut items, unreadable_location_count) = platform_startup_items(&home);
    items.sort_by(|left, right| {
        left.system
            .cmp(&right.system)
            .then_with(|| right.enabled.cmp(&left.enabled))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let management_available = items
        .iter()
        .any(|item| item.management_status == StartupManagementStatus::Available);
    Ok(StartupItemsSnapshot {
        sampled_at_ms: now_millis(),
        items,
        unreadable_location_count,
        management_available,
    })
}

#[cfg(target_os = "macos")]
fn platform_startup_items(home: &Path) -> (Vec<StartupItem>, usize) {
    let user_launch_agents = home.join("Library/LaunchAgents");
    let disabled_launch_agents = macos_disabled_directory(home);
    let definitions = [
        (
            user_launch_agents.clone(),
            StartupItemSource::LaunchAgent,
            StartupItemScope::User,
        ),
        (
            PathBuf::from("/Library/LaunchAgents"),
            StartupItemSource::LaunchAgent,
            StartupItemScope::System,
        ),
        (
            PathBuf::from("/Library/LaunchDaemons"),
            StartupItemSource::LaunchDaemon,
            StartupItemScope::System,
        ),
        (
            PathBuf::from("/System/Library/LaunchAgents"),
            StartupItemSource::LaunchAgent,
            StartupItemScope::System,
        ),
        (
            PathBuf::from("/System/Library/LaunchDaemons"),
            StartupItemSource::LaunchDaemon,
            StartupItemScope::System,
        ),
    ];
    let mut items = Vec::new();
    let mut unreadable = 0;
    for (directory, source, scope) in definitions {
        match scan_macos_plists(&directory, &directory, source, scope, false) {
            Ok(mut found) => items.append(&mut found),
            Err(()) if directory.exists() => unreadable += 1,
            Err(()) => {}
        }
    }
    match scan_macos_plists(
        &disabled_launch_agents,
        &user_launch_agents,
        StartupItemSource::LaunchAgent,
        StartupItemScope::User,
        true,
    ) {
        Ok(mut found) => items.append(&mut found),
        Err(()) if disabled_launch_agents.exists() => unreadable += 1,
        Err(()) => {}
    }
    (items, unreadable)
}

#[cfg(target_os = "macos")]
fn scan_macos_plists(
    directory: &Path,
    original_directory: &Path,
    source: StartupItemSource,
    scope: StartupItemScope,
    managed_disabled: bool,
) -> Result<Vec<StartupItem>, ()> {
    let entries = fs::read_dir(directory).map_err(|_| ())?;
    Ok(entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "plist")
        })
        .filter_map(|entry| {
            let original_path = original_directory.join(entry.file_name());
            macos_startup_item(
                &entry.path(),
                &original_path,
                source,
                scope,
                managed_disabled,
            )
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn macos_startup_item(
    source_path: &Path,
    original_path: &Path,
    source: StartupItemSource,
    scope: StartupItemScope,
    managed_disabled: bool,
) -> Option<StartupItem> {
    let value = plist::Value::from_file(source_path).ok()?;
    let dictionary = value.as_dictionary()?;
    let fallback = original_path.file_stem()?.to_string_lossy().into_owned();
    let label = dictionary
        .get("Label")
        .and_then(plist::Value::as_string)
        .unwrap_or(&fallback)
        .to_owned();
    let program = dictionary
        .get("Program")
        .and_then(plist::Value::as_string)
        .map(str::to_owned)
        .or_else(|| {
            dictionary
                .get("ProgramArguments")
                .and_then(plist::Value::as_array)
                .and_then(|arguments| arguments.first())
                .and_then(plist::Value::as_string)
                .map(str::to_owned)
        });
    let disabled = dictionary
        .get("Disabled")
        .and_then(plist::Value::as_boolean)
        .unwrap_or(false);
    let login = dictionary
        .get("RunAtLoad")
        .and_then(plist::Value::as_boolean)
        .unwrap_or(false);
    let keep_alive = dictionary
        .get("KeepAlive")
        .is_some_and(|value| match value {
            plist::Value::Boolean(enabled) => *enabled,
            plist::Value::Dictionary(_) => true,
            _ => false,
        });
    let protected = label.starts_with("com.apple.");
    let system = scope == StartupItemScope::System || protected;
    let enabled = if managed_disabled { false } else { !disabled };
    let management_status = if scope == StartupItemScope::System {
        StartupManagementStatus::System
    } else if protected {
        StartupManagementStatus::Protected
    } else if disabled && !managed_disabled {
        StartupManagementStatus::Unsupported
    } else {
        StartupManagementStatus::Available
    };
    Some(StartupItem {
        id: format!(
            "{}:{}",
            source_name(source),
            original_path.to_string_lossy()
        ),
        name: friendly_label(&label),
        publisher: publisher_from_label(&label),
        command: program,
        path: original_path.to_string_lossy().into_owned(),
        source,
        scope,
        enabled,
        system,
        launch_kind: if login || keep_alive {
            StartupLaunchKind::Login
        } else {
            StartupLaunchKind::Conditional
        },
        management_status,
    })
}

#[cfg(target_os = "linux")]
fn platform_startup_items(home: &Path) -> (Vec<StartupItem>, usize) {
    let user_autostart = home.join(".config/autostart");
    let disabled_autostart = linux_disabled_directory(home);
    let definitions = [
        (user_autostart.clone(), StartupItemScope::User),
        (
            PathBuf::from("/etc/xdg/autostart"),
            StartupItemScope::System,
        ),
    ];
    let mut items = Vec::new();
    let mut unreadable = 0;
    for (directory, scope) in definitions {
        match scan_linux_desktop_entries(&directory, &directory, scope, false) {
            Ok(mut found) => items.append(&mut found),
            Err(()) if directory.exists() => unreadable += 1,
            Err(()) => {}
        }
    }
    match scan_linux_desktop_entries(
        &disabled_autostart,
        &user_autostart,
        StartupItemScope::User,
        true,
    ) {
        Ok(mut found) => items.append(&mut found),
        Err(()) if disabled_autostart.exists() => unreadable += 1,
        Err(()) => {}
    }
    (items, unreadable)
}

#[cfg(target_os = "linux")]
fn scan_linux_desktop_entries(
    directory: &Path,
    original_directory: &Path,
    scope: StartupItemScope,
    managed_disabled: bool,
) -> Result<Vec<StartupItem>, ()> {
    let entries = fs::read_dir(directory).map_err(|_| ())?;
    Ok(entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "desktop")
        })
        .filter_map(|entry| {
            let original_path = original_directory.join(entry.file_name());
            linux_desktop_item(&entry.path(), &original_path, scope, managed_disabled)
        })
        .collect())
}

#[cfg(target_os = "linux")]
fn linux_desktop_item(
    source_path: &Path,
    original_path: &Path,
    scope: StartupItemScope,
    managed_disabled: bool,
) -> Option<StartupItem> {
    let content = fs::read_to_string(source_path).ok()?;
    let field = |name: &str| {
        content
            .lines()
            .filter_map(|line| line.split_once('='))
            .find_map(|(key, value)| (key.trim() == name).then(|| value.trim().to_owned()))
    };
    let name = field("Name").or_else(|| {
        original_path
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
    })?;
    let configured_hidden = field("Hidden").is_some_and(|value| value.eq_ignore_ascii_case("true"));
    let enabled = !managed_disabled && !configured_hidden;
    let management_status = if scope == StartupItemScope::System {
        StartupManagementStatus::System
    } else if configured_hidden && !managed_disabled {
        StartupManagementStatus::Unsupported
    } else {
        StartupManagementStatus::Available
    };
    Some(StartupItem {
        id: format!("desktop-entry:{}", original_path.to_string_lossy()),
        name,
        publisher: None,
        command: field("Exec"),
        path: original_path.to_string_lossy().into_owned(),
        source: StartupItemSource::DesktopEntry,
        scope,
        enabled,
        system: scope == StartupItemScope::System,
        launch_kind: StartupLaunchKind::Login,
        management_status,
    })
}

#[cfg(windows)]
fn platform_startup_items(home: &Path) -> (Vec<StartupItem>, usize) {
    use std::process::Command;

    let registry_locations = [
        (
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            StartupItemScope::User,
        ),
        (
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
            StartupItemScope::System,
        ),
    ];
    let mut items = Vec::new();
    let mut unreadable = 0;
    for (key, scope) in registry_locations {
        match Command::new("reg").args(["query", key]).output() {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines().filter(|line| line.contains("REG_SZ")) {
                    let Some((name, command)) = line.trim().split_once("REG_SZ") else {
                        continue;
                    };
                    let name = name.trim().to_owned();
                    items.push(StartupItem {
                        id: format!("registry:{key}:{name}"),
                        publisher: publisher_from_label(&name),
                        name,
                        command: Some(command.trim().to_owned()),
                        path: key.to_owned(),
                        source: StartupItemSource::RegistryRun,
                        scope,
                        enabled: true,
                        system: scope == StartupItemScope::System,
                        launch_kind: StartupLaunchKind::Login,
                        management_status: if scope == StartupItemScope::System {
                            StartupManagementStatus::System
                        } else {
                            StartupManagementStatus::Unsupported
                        },
                    });
                }
            }
            Ok(_) | Err(_) => unreadable += 1,
        }
    }
    let user_startup_directory = env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join(r"Microsoft\Windows\Start Menu\Programs\Startup"));
    let startup_directories = [
        user_startup_directory.clone(),
        env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .map(|path| path.join(r"Microsoft\Windows\Start Menu\Programs\StartUp")),
    ];
    for (index, directory) in startup_directories.into_iter().enumerate() {
        let Some(directory) = directory else { continue };
        let scope = if index == 0 {
            StartupItemScope::User
        } else {
            StartupItemScope::System
        };
        match fs::read_dir(&directory) {
            Ok(entries) => {
                items.extend(entries.filter_map(Result::ok).map(|entry| {
                    StartupItem {
                        id: format!("startup-folder:{}", entry.path().to_string_lossy()),
                        name: entry
                            .path()
                            .file_stem()
                            .map(|value| value.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Startup item".to_owned()),
                        publisher: None,
                        command: Some(entry.path().to_string_lossy().into_owned()),
                        path: entry.path().to_string_lossy().into_owned(),
                        source: StartupItemSource::StartupFolder,
                        scope,
                        enabled: true,
                        system: scope == StartupItemScope::System,
                        launch_kind: StartupLaunchKind::Login,
                        management_status: if scope == StartupItemScope::System {
                            StartupManagementStatus::System
                        } else {
                            StartupManagementStatus::Available
                        },
                    }
                }));
            }
            Err(_) if directory.exists() => unreadable += 1,
            Err(_) => {}
        }
    }
    if let Some(original_directory) = user_startup_directory {
        let disabled_directory = windows_disabled_directory(home);
        match fs::read_dir(&disabled_directory) {
            Ok(entries) => {
                items.extend(entries.filter_map(Result::ok).map(|entry| {
                    let original_path = original_directory.join(entry.file_name());
                    StartupItem {
                        id: format!("startup-folder:{}", original_path.to_string_lossy()),
                        name: original_path
                            .file_stem()
                            .map(|value| value.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Startup item".to_owned()),
                        publisher: None,
                        command: Some(original_path.to_string_lossy().into_owned()),
                        path: original_path.to_string_lossy().into_owned(),
                        source: StartupItemSource::StartupFolder,
                        scope: StartupItemScope::User,
                        enabled: false,
                        system: false,
                        launch_kind: StartupLaunchKind::Login,
                        management_status: StartupManagementStatus::Available,
                    }
                }));
            }
            Err(_) if disabled_directory.exists() => unreadable += 1,
            Err(_) => {}
        }
    }
    (items, unreadable)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_startup_items(_home: &Path) -> (Vec<StartupItem>, usize) {
    (Vec::new(), 0)
}

#[cfg(target_os = "macos")]
fn macos_disabled_directory(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Pulse/Disabled Startup Items/LaunchAgents")
}

#[cfg(target_os = "linux")]
fn linux_disabled_directory(home: &Path) -> PathBuf {
    home.join(".local/share/pulse/disabled-startup/autostart")
}

#[cfg(windows)]
fn windows_disabled_directory(home: &Path) -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"))
        .join("Pulse/Disabled Startup Items/Startup")
}

#[cfg(target_os = "macos")]
fn disabled_path_for_item(home: &Path, item: &StartupItem) -> Result<PathBuf, CommandError> {
    let active_path = PathBuf::from(&item.path);
    if item.source != StartupItemSource::LaunchAgent
        || active_path.parent() != Some(home.join("Library/LaunchAgents").as_path())
    {
        return Err(CommandError::new(
            "startup_item_protected",
            "Pulse only manages user LaunchAgent files from the standard folder.",
        ));
    }
    let file_name = active_path.file_name().ok_or_else(|| {
        CommandError::new(
            "startup_item_unavailable",
            "The startup item has no file name.",
        )
    })?;
    Ok(macos_disabled_directory(home).join(file_name))
}

#[cfg(target_os = "linux")]
fn disabled_path_for_item(home: &Path, item: &StartupItem) -> Result<PathBuf, CommandError> {
    let active_path = PathBuf::from(&item.path);
    if item.source != StartupItemSource::DesktopEntry
        || active_path.parent() != Some(home.join(".config/autostart").as_path())
    {
        return Err(CommandError::new(
            "startup_item_protected",
            "Pulse only manages user desktop autostart files from the standard folder.",
        ));
    }
    let file_name = active_path.file_name().ok_or_else(|| {
        CommandError::new(
            "startup_item_unavailable",
            "The startup item has no file name.",
        )
    })?;
    Ok(linux_disabled_directory(home).join(file_name))
}

#[cfg(windows)]
fn disabled_path_for_item(home: &Path, item: &StartupItem) -> Result<PathBuf, CommandError> {
    if item.source != StartupItemSource::StartupFolder {
        return Err(CommandError::new(
            "startup_item_protected",
            "Pulse only manages files in the current user's Startup folder on Windows.",
        ));
    }
    let active_path = PathBuf::from(&item.path);
    let expected_parent = env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
        .ok_or_else(|| {
            CommandError::new(
                "startup_item_unavailable",
                "Windows did not provide the current user's Startup folder.",
            )
        })?;
    if active_path.parent() != Some(expected_parent.as_path()) {
        return Err(CommandError::new(
            "startup_item_protected",
            "The startup item is outside the current user's Startup folder.",
        ));
    }
    let file_name = active_path.file_name().ok_or_else(|| {
        CommandError::new(
            "startup_item_unavailable",
            "The startup item has no file name.",
        )
    })?;
    Ok(windows_disabled_directory(home).join(file_name))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn disabled_path_for_item(_home: &Path, _item: &StartupItem) -> Result<PathBuf, CommandError> {
    Err(CommandError::new(
        "startup_item_protected",
        "Startup management is unavailable on this platform.",
    ))
}

fn startup_file_fingerprint(
    path: &Path,
    canonical_home: &Path,
) -> Result<FileFingerprint, CommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        CommandError::new(
            "startup_item_unavailable",
            format!("Pulse could not inspect the startup file: {error}"),
        )
    })?;
    validate_startup_file_type(&metadata)?;
    let canonical_path = path.canonicalize().map_err(|error| {
        CommandError::new(
            "startup_item_unavailable",
            format!("Pulse could not verify the startup file: {error}"),
        )
    })?;
    if !canonical_path.starts_with(canonical_home) {
        return Err(CommandError::new(
            "startup_item_protected",
            "The startup file is outside the current user's profile. Pulse changed nothing.",
        ));
    }
    if metadata.len() > MAX_STARTUP_FILE_BYTES {
        return Err(CommandError::new(
            "startup_item_protected",
            "The startup file is unexpectedly large. Pulse changed nothing.",
        ));
    }
    let content = fs::read(path).map_err(|error| {
        CommandError::new(
            "startup_item_unavailable",
            format!("Pulse could not read the startup file for verification: {error}"),
        )
    })?;
    Ok(file_fingerprint(&metadata, &content))
}

fn validate_startup_source(
    path: &Path,
    expected: FileFingerprint,
    canonical_home: &Path,
) -> Result<(), CommandError> {
    let actual = startup_file_fingerprint(path, canonical_home)?;
    if actual != expected {
        return Err(CommandError::new(
            "startup_state_changed",
            "This startup file changed after confirmation. Pulse changed nothing.",
        ));
    }
    Ok(())
}

fn validate_startup_file_type(metadata: &Metadata) -> Result<(), CommandError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CommandError::new(
            "startup_item_protected",
            "Pulse will not manage links or special files as startup items.",
        ));
    }
    Ok(())
}

fn file_fingerprint(metadata: &Metadata, content: &[u8]) -> FileFingerprint {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    FileFingerprint {
        length: metadata.len(),
        modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
        content_hash: hasher.finish(),
    }
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn move_startup_file_without_overwrite(
    source: &Path,
    destination: &Path,
) -> Result<(), CommandError> {
    fs::hard_link(source, destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CommandError::new(
                "startup_destination_conflict",
                "Another startup configuration appeared at the destination. Pulse refused to overwrite it.",
            )
        } else {
            CommandError::new(
                "startup_management_failed",
                format!("Pulse could not create a reversible startup copy: {error}"),
            )
        }
    })?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(destination);
        return Err(CommandError::new(
            "startup_management_failed",
            format!("Pulse could not finish moving the startup configuration: {error}"),
        ));
    }
    Ok(())
}

fn friendly_label(label: &str) -> String {
    label
        .split(['.', '-', '_'])
        .rfind(|part| {
            !matches!(
                *part,
                "com" | "org" | "net" | "io" | "app" | "helper" | "agent" | "daemon"
            )
        })
        .filter(|part| !part.is_empty())
        .unwrap_or(label)
        .split_whitespace()
        .map(title_case)
        .collect::<Vec<_>>()
        .join(" ")
}

fn publisher_from_label(label: &str) -> Option<String> {
    let parts = label.split(['.', '-', '_']).collect::<Vec<_>>();
    let candidate = if matches!(parts.first().copied(), Some("com" | "org" | "net" | "io")) {
        parts.get(1).copied()
    } else {
        parts.first().copied()
    }?;
    (!candidate.is_empty()).then(|| title_case(candidate))
}

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

fn source_name(source: StartupItemSource) -> &'static str {
    match source {
        StartupItemSource::LaunchAgent => "launch-agent",
        StartupItemSource::LaunchDaemon => "launch-daemon",
        StartupItemSource::DesktopEntry => "desktop-entry",
        StartupItemSource::RegistryRun => "registry-run",
        StartupItemSource::StartupFolder => "startup-folder",
    }
}

fn home_directory() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use std::fs;
    #[cfg(target_os = "macos")]
    use std::path::{Path, PathBuf};

    #[cfg(target_os = "macos")]
    use crate::models::{
        StartupManagementAction, StartupManagementExecutionRequest, StartupManagementLeaseRequest,
        StartupManagementStatus,
    };

    #[cfg(target_os = "macos")]
    use super::{StartupController, macos_disabled_directory, platform_startup_items};
    use super::{friendly_label, publisher_from_label};

    #[test]
    fn makes_reverse_domain_labels_readable() {
        assert_eq!(friendly_label("com.spotify.client.helper"), "Client");
        assert_eq!(
            publisher_from_label("com.spotify.client.helper").as_deref(),
            Some("Spotify")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn user_launch_agent_can_be_disabled_and_restored_without_deleting_it() {
        let root = test_root("round-trip");
        let active = write_launch_agent(&root, "com.example.sync.plist", "com.example.sync");
        let item_id = format!("launch-agent:{}", active.to_string_lossy());
        let mut controller = StartupController::default();

        let disable = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id: item_id.clone(),
                    action: StartupManagementAction::Disable,
                },
                &root,
            )
            .unwrap();
        let disabled_result = controller
            .execute(StartupManagementExecutionRequest {
                lease_id: disable.id.clone(),
            })
            .unwrap();
        assert!(!disabled_result.enabled);
        assert!(!active.exists());
        assert!(
            macos_disabled_directory(&root)
                .join("com.example.sync.plist")
                .exists()
        );

        let (items, _) = platform_startup_items(&root);
        let disabled_item = items.iter().find(|item| item.id == item_id).unwrap();
        assert!(!disabled_item.enabled);
        assert_eq!(
            disabled_item.management_status,
            StartupManagementStatus::Available
        );

        let reused = controller
            .execute(StartupManagementExecutionRequest {
                lease_id: disable.id,
            })
            .unwrap_err();
        assert_eq!(reused.code, "startup_confirmation_unavailable");

        let enable = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id,
                    action: StartupManagementAction::Enable,
                },
                &root,
            )
            .unwrap();
        let enabled_result = controller
            .execute(StartupManagementExecutionRequest {
                lease_id: enable.id,
            })
            .unwrap();
        assert!(enabled_result.enabled);
        assert!(active.exists());
        assert!(
            !macos_disabled_directory(&root)
                .join("com.example.sync.plist")
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_management_rejects_protected_and_changed_files() {
        let root = test_root("protected");
        let apple = write_launch_agent(&root, "com.apple.fake.plist", "com.apple.fake");
        let changed = write_launch_agent(&root, "com.example.changed.plist", "com.example.changed");
        let mut controller = StartupController::default();

        let protected = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id: format!("launch-agent:{}", apple.to_string_lossy()),
                    action: StartupManagementAction::Disable,
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(protected.code, "startup_item_protected");

        let lease = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id: format!("launch-agent:{}", changed.to_string_lossy()),
                    action: StartupManagementAction::Disable,
                },
                &root,
            )
            .unwrap();
        fs::write(&changed, launch_agent_plist("com.example.replaced")).unwrap();
        let error = controller
            .execute(StartupManagementExecutionRequest { lease_id: lease.id })
            .unwrap_err();
        assert_eq!(error.code, "startup_state_changed");
        assert!(changed.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_management_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink");
        let agents = root.join("Library/LaunchAgents");
        fs::create_dir_all(&agents).unwrap();
        let target = root.join("target.plist");
        fs::write(&target, launch_agent_plist("com.example.linked")).unwrap();
        let linked = agents.join("com.example.linked.plist");
        symlink(&target, &linked).unwrap();
        let mut controller = StartupController::default();

        let error = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id: format!("launch-agent:{}", linked.to_string_lossy()),
                    action: StartupManagementAction::Disable,
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(error.code, "startup_item_protected");
        assert!(linked.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    fn write_launch_agent(root: &Path, file_name: &str, label: &str) -> PathBuf {
        let directory = root.join("Library/LaunchAgents");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(file_name);
        fs::write(&path, launch_agent_plist(label)).unwrap();
        path
    }

    #[cfg(target_os = "macos")]
    fn launch_agent_plist(label: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>{label}</string><key>Program</key><string>/Applications/Example.app/Contents/MacOS/Example</string><key>RunAtLoad</key><true/></dict></plist>"#
        )
    }

    #[cfg(target_os = "macos")]
    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pulse-startup-{name}-{}-{}",
            std::process::id(),
            super::now_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }
}
