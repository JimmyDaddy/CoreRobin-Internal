use std::env;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::models::{
    StartupItem, StartupItemScope, StartupItemSource, StartupItemsSnapshot, StartupLaunchKind,
    StartupManagementAction, StartupManagementExecutionRequest, StartupManagementLease,
    StartupManagementLeaseRequest, StartupManagementResult, StartupManagementStatus,
};
use crate::safe_fs::{BoundFileMove, SafeFileMoveRoot, SafeFileSnapshot};

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
    source_fingerprint: FileFingerprint,
    bound_move: BoundFileMove,
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
                "StatusOrbit could not locate the current user's home directory.",
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
        let snapshot = lease
            .bound_move
            .source_snapshot(MAX_STARTUP_FILE_BYTES)
            .map_err(|error| {
                CommandError::new(
                    "startup_state_changed",
                    format!(
                        "This startup file changed after confirmation. StatusOrbit changed nothing: {error}"
                    ),
                )
            })?;
        if file_fingerprint(&snapshot) != lease.source_fingerprint {
            return Err(CommandError::new(
                "startup_state_changed",
                "This startup file changed after confirmation. StatusOrbit changed nothing.",
            ));
        }
        lease.bound_move.execute().map_err(map_startup_move_error)?;
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
                "StatusOrbit only manages recognized third-party startup files in the current user's profile.",
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
                format!("StatusOrbit could not verify the current user's home directory: {error}"),
            )
        })?;
        let move_root = SafeFileMoveRoot::open(&canonical_home).map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("StatusOrbit could not open a stable home directory handle: {error}"),
            )
        })?;
        let source_relative = relative_to_home(&source_path, home, &canonical_home)?;
        let destination_relative = relative_to_home(&destination_path, home, &canonical_home)?;
        let source_parent = source_relative
            .parent()
            .ok_or_else(|| CommandError::internal("The startup source has no parent directory."))?;
        let destination_parent = destination_relative.parent().ok_or_else(|| {
            CommandError::internal("The startup destination has no parent directory.")
        })?;
        if request.action == StartupManagementAction::Enable {
            move_root
                .ensure_directory(source_parent, true)
                .map_err(|error| {
                    CommandError::new(
                        "startup_management_failed",
                        format!(
                            "StatusOrbit could not secure its reversible startup storage: {error}"
                        ),
                    )
                })?;
        }
        move_root
            .ensure_directory(
                destination_parent,
                request.action == StartupManagementAction::Disable,
            )
            .map_err(|error| {
                CommandError::new(
                    "startup_management_failed",
                    format!(
                        "StatusOrbit could not prepare its reversible startup storage: {error}"
                    ),
                )
            })?;
        let bound_move = move_root
            .bind_file_move(&source_relative, &destination_relative)
            .map_err(map_startup_binding_error)?;
        let source_snapshot = bound_move
            .source_snapshot(MAX_STARTUP_FILE_BYTES)
            .map_err(map_startup_binding_error)?;
        let source_fingerprint = file_fingerprint(&source_snapshot);
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
            source_fingerprint,
            bound_move,
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
            "StatusOrbit could not locate the current user's home directory.",
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
    for disabled_launch_agents in macos_disabled_directories(home) {
        match scan_macos_plists(
            &disabled_launch_agents,
            &user_launch_agents,
            StartupItemSource::LaunchAgent,
            StartupItemScope::User,
            true,
        ) {
            Ok(found) => append_unique_startup_items(&mut items, found),
            Err(()) if disabled_launch_agents.exists() => unreadable += 1,
            Err(()) => {}
        }
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
    for disabled_autostart in linux_disabled_directories(home) {
        match scan_linux_desktop_entries(
            &disabled_autostart,
            &user_autostart,
            StartupItemScope::User,
            true,
        ) {
            Ok(found) => append_unique_startup_items(&mut items, found),
            Err(()) if disabled_autostart.exists() => unreadable += 1,
            Err(()) => {}
        }
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
        for disabled_directory in windows_disabled_directories(home) {
            match fs::read_dir(&disabled_directory) {
                Ok(entries) => {
                    let found = entries.filter_map(Result::ok).map(|entry| {
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
                    });
                    append_unique_startup_items(&mut items, found);
                }
                Err(_) if disabled_directory.exists() => unreadable += 1,
                Err(_) => {}
            }
        }
    }
    (items, unreadable)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_startup_items(_home: &Path) -> (Vec<StartupItem>, usize) {
    (Vec::new(), 0)
}

#[cfg(target_os = "macos")]
fn macos_disabled_directories(home: &Path) -> [PathBuf; 2] {
    [
        home.join("Library/Application Support/StatusOrbit/Disabled Startup Items/LaunchAgents"),
        home.join("Library/Application Support/Pulse/Disabled Startup Items/LaunchAgents"),
    ]
}

#[cfg(target_os = "linux")]
fn linux_disabled_directories(home: &Path) -> [PathBuf; 2] {
    [
        home.join(".local/share/status-orbit/disabled-startup/autostart"),
        home.join(".local/share/pulse/disabled-startup/autostart"),
    ]
}

#[cfg(windows)]
fn windows_disabled_directories(home: &Path) -> [PathBuf; 2] {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    [
        local_app_data.join("StatusOrbit/Disabled Startup Items/Startup"),
        local_app_data.join("Pulse/Disabled Startup Items/Startup"),
    ]
}

fn append_unique_startup_items<I>(items: &mut Vec<StartupItem>, found: I)
where
    I: IntoIterator<Item = StartupItem>,
{
    for item in found {
        if !items.iter().any(|existing| existing.id == item.id) {
            items.push(item);
        }
    }
}

fn existing_or_current_disabled_path(
    directories: impl IntoIterator<Item = PathBuf>,
    file_name: &std::ffi::OsStr,
) -> PathBuf {
    let mut candidates = directories.into_iter().map(|path| path.join(file_name));
    let current = candidates
        .next()
        .expect("disabled startup storage always has a current directory");
    if current.exists() {
        return current;
    }
    candidates.find(|path| path.exists()).unwrap_or(current)
}

#[cfg(target_os = "macos")]
fn disabled_path_for_item(home: &Path, item: &StartupItem) -> Result<PathBuf, CommandError> {
    let active_path = PathBuf::from(&item.path);
    if item.source != StartupItemSource::LaunchAgent
        || active_path.parent() != Some(home.join("Library/LaunchAgents").as_path())
    {
        return Err(CommandError::new(
            "startup_item_protected",
            "StatusOrbit only manages user LaunchAgent files from the standard folder.",
        ));
    }
    let file_name = active_path.file_name().ok_or_else(|| {
        CommandError::new(
            "startup_item_unavailable",
            "The startup item has no file name.",
        )
    })?;
    Ok(existing_or_current_disabled_path(
        macos_disabled_directories(home),
        file_name,
    ))
}

#[cfg(target_os = "linux")]
fn disabled_path_for_item(home: &Path, item: &StartupItem) -> Result<PathBuf, CommandError> {
    let active_path = PathBuf::from(&item.path);
    if item.source != StartupItemSource::DesktopEntry
        || active_path.parent() != Some(home.join(".config/autostart").as_path())
    {
        return Err(CommandError::new(
            "startup_item_protected",
            "StatusOrbit only manages user desktop autostart files from the standard folder.",
        ));
    }
    let file_name = active_path.file_name().ok_or_else(|| {
        CommandError::new(
            "startup_item_unavailable",
            "The startup item has no file name.",
        )
    })?;
    Ok(existing_or_current_disabled_path(
        linux_disabled_directories(home),
        file_name,
    ))
}

#[cfg(windows)]
fn disabled_path_for_item(home: &Path, item: &StartupItem) -> Result<PathBuf, CommandError> {
    if item.source != StartupItemSource::StartupFolder {
        return Err(CommandError::new(
            "startup_item_protected",
            "StatusOrbit only manages files in the current user's Startup folder on Windows.",
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
    Ok(existing_or_current_disabled_path(
        windows_disabled_directories(home),
        file_name,
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn disabled_path_for_item(_home: &Path, _item: &StartupItem) -> Result<PathBuf, CommandError> {
    Err(CommandError::new(
        "startup_item_protected",
        "Startup management is unavailable on this platform.",
    ))
}

fn file_fingerprint(snapshot: &SafeFileSnapshot) -> FileFingerprint {
    let mut hasher = DefaultHasher::new();
    snapshot.contents.hash(&mut hasher);
    FileFingerprint {
        length: snapshot.length,
        modified_at_ms: snapshot.modified_at.and_then(system_time_millis),
        content_hash: hasher.finish(),
    }
}

fn relative_to_home(
    path: &Path,
    home: &Path,
    canonical_home: &Path,
) -> Result<PathBuf, CommandError> {
    path.strip_prefix(home)
        .or_else(|_| path.strip_prefix(canonical_home))
        .map(Path::to_path_buf)
        .map_err(|_| {
            CommandError::new(
                "startup_item_protected",
                "The startup file is outside the current user's profile. StatusOrbit changed nothing.",
            )
        })
}

fn map_startup_binding_error(error: io::Error) -> CommandError {
    match error.kind() {
        io::ErrorKind::AlreadyExists => CommandError::new(
            "startup_destination_conflict",
            "Another startup configuration already exists at the destination. StatusOrbit changed nothing.",
        ),
        io::ErrorKind::NotFound => CommandError::new(
            "startup_item_unavailable",
            format!("The startup file or its parent is no longer available: {error}"),
        ),
        io::ErrorKind::InvalidData | io::ErrorKind::PermissionDenied => CommandError::new(
            "startup_item_protected",
            format!("StatusOrbit refused an unsafe startup file operation: {error}"),
        ),
        _ => CommandError::new(
            "startup_management_failed",
            format!("StatusOrbit could not safely bind the startup file: {error}"),
        ),
    }
}

fn map_startup_move_error(error: io::Error) -> CommandError {
    match error.kind() {
        io::ErrorKind::AlreadyExists => CommandError::new(
            "startup_destination_conflict",
            "Another startup configuration appeared at the destination. StatusOrbit refused to overwrite it.",
        ),
        io::ErrorKind::NotFound | io::ErrorKind::InvalidData => CommandError::new(
            "startup_state_changed",
            format!(
                "The startup source or destination changed. StatusOrbit stopped safely: {error}"
            ),
        ),
        _ => CommandError::new(
            "startup_management_failed",
            format!("StatusOrbit could not safely move the startup configuration: {error}"),
        ),
    }
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(any(target_os = "macos", windows, test))]
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

#[cfg(any(target_os = "macos", windows, test))]
fn publisher_from_label(label: &str) -> Option<String> {
    let parts = label.split(['.', '-', '_']).collect::<Vec<_>>();
    let candidate = if matches!(parts.first().copied(), Some("com" | "org" | "net" | "io")) {
        parts.get(1).copied()
    } else {
        parts.first().copied()
    }?;
    (!candidate.is_empty()).then(|| title_case(candidate))
}

#[cfg(any(target_os = "macos", windows, test))]
fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
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
    use super::{StartupController, macos_disabled_directories, platform_startup_items};
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
            macos_disabled_directories(&root)[0]
                .join("com.example.sync.plist")
                .exists()
        );
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(&macos_disabled_directories(&root)[0])
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
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
            !macos_disabled_directories(&root)[0]
                .join("com.example.sync.plist")
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_disabled_launch_agent_can_be_restored_after_rename() {
        let root = test_root("legacy-restore");
        fs::create_dir_all(root.join("Library/LaunchAgents")).unwrap();
        let file_name = "com.example.legacy.plist";
        let legacy_disabled = macos_disabled_directories(&root)[1].join(file_name);
        fs::create_dir_all(legacy_disabled.parent().unwrap()).unwrap();
        fs::write(&legacy_disabled, launch_agent_plist("com.example.legacy")).unwrap();
        let active = root.join("Library/LaunchAgents").join(file_name);
        let item_id = format!("launch-agent:{}", active.to_string_lossy());

        let (items, _) = platform_startup_items(&root);
        assert!(items.iter().any(|item| item.id == item_id && !item.enabled));

        let mut controller = StartupController::default();
        let enable = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id,
                    action: StartupManagementAction::Enable,
                },
                &root,
            )
            .unwrap();
        controller
            .execute(StartupManagementExecutionRequest {
                lease_id: enable.id,
            })
            .unwrap();

        assert!(active.exists());
        assert!(!legacy_disabled.exists());
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
    #[test]
    fn startup_management_never_overwrites_a_competing_destination() {
        let root = test_root("destination-conflict");
        let active = write_launch_agent(&root, "com.example.sync.plist", "com.example.sync");
        let mut controller = StartupController::default();
        let lease = controller
            .create_lease_for_home(
                StartupManagementLeaseRequest {
                    item_id: format!("launch-agent:{}", active.to_string_lossy()),
                    action: StartupManagementAction::Disable,
                },
                &root,
            )
            .unwrap();
        let destination = macos_disabled_directories(&root)[0].join("com.example.sync.plist");
        fs::write(&destination, b"competition").unwrap();

        let error = controller
            .execute(StartupManagementExecutionRequest { lease_id: lease.id })
            .unwrap_err();
        assert_eq!(error.code, "startup_destination_conflict");
        assert!(active.exists());
        assert_eq!(fs::read(destination).unwrap(), b"competition");
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
            "status-orbit-startup-{name}-{}-{}",
            std::process::id(),
            super::now_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }
}
