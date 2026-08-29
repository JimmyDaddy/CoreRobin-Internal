use std::env;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "macos")]
use crate::bounded_command;
use crate::error::CommandError;
use crate::models::{
    StartupItem, StartupItemScope, StartupItemSource, StartupItemsSnapshot, StartupLaunchKind,
    StartupManagementAction, StartupManagementExecutionRequest, StartupManagementLease,
    StartupManagementLeaseRequest, StartupManagementResult, StartupManagementStatus,
    StartupManagementVerification, StartupScanIssue, StartupScanWarning,
};
use crate::safe_fs::{BoundFileMove, SafeFileMoveRoot, SafeFileSnapshot};

const STARTUP_LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_STARTUP_LEASES: usize = 16;
const MAX_STARTUP_FILE_BYTES: u64 = 2 * 1_024 * 1_024;
#[cfg(target_os = "macos")]
const STARTUP_METADATA_TIMEOUT: Duration = Duration::from_millis(1_500);
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
    item: StartupItem,
    home: PathBuf,
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
                "CoreRobin could not locate the current user's home directory.",
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
                        "This startup file changed after confirmation. CoreRobin changed nothing: {error}"
                    ),
                )
            })?;
        if file_fingerprint(&snapshot) != lease.source_fingerprint {
            return Err(CommandError::new(
                "startup_state_changed",
                "This startup file changed after confirmation. CoreRobin changed nothing.",
            ));
        }
        lease.bound_move.execute().map_err(map_startup_move_error)?;
        let expected_enabled = lease.action == StartupManagementAction::Enable;
        let (verification, snapshot) =
            verify_startup_management(&lease.item, expected_enabled, &lease.home);
        Ok(StartupManagementResult {
            item_id: lease.item_id,
            enabled: expected_enabled,
            verification: verification.status,
            related_item_count: verification.related_item_count,
            unresolved_source_count: verification.unresolved_source_count,
            requires_system_settings: verification.requires_system_settings,
            snapshot,
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
        let item = targeted_startup_item(&request.item_id, home).ok_or_else(|| {
            CommandError::new(
                "startup_item_unavailable",
                "This startup item is no longer available. Refresh the list and try again.",
            )
        })?;
        if item.management_status != StartupManagementStatus::Available {
            return Err(CommandError::new(
                "startup_item_protected",
                "CoreRobin only manages recognized third-party startup files in the current user's profile.",
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
                format!("CoreRobin could not verify the current user's home directory: {error}"),
            )
        })?;
        let move_root = SafeFileMoveRoot::open(&canonical_home).map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("CoreRobin could not open a stable home directory handle: {error}"),
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
                            "CoreRobin could not secure its reversible startup storage: {error}"
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
                    format!("CoreRobin could not prepare its reversible startup storage: {error}"),
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
            item: item.clone(),
            home: home.to_path_buf(),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StartupVerificationResult {
    status: StartupManagementVerification,
    related_item_count: usize,
    unresolved_source_count: usize,
    requires_system_settings: bool,
}

fn verify_startup_management(
    requested_item: &StartupItem,
    expected_enabled: bool,
    home: &Path,
) -> (StartupVerificationResult, StartupItemsSnapshot) {
    let snapshot = startup_items_snapshot_for_home(home);
    let result = evaluate_startup_management(requested_item, expected_enabled, &snapshot.items);
    (
        apply_startup_scan_warnings(result, &snapshot.scan_warnings),
        snapshot,
    )
}

fn apply_startup_scan_warnings(
    mut result: StartupVerificationResult,
    warnings: &[StartupScanWarning],
) -> StartupVerificationResult {
    let unresolved_source_count = warnings
        .iter()
        .filter(|warning| warning.issue != StartupScanIssue::InvalidEntry)
        .map(|warning| warning.count)
        .sum();
    result.unresolved_source_count = unresolved_source_count;
    if result.status == StartupManagementVerification::Complete && unresolved_source_count > 0 {
        result.status = StartupManagementVerification::Partial;
    }
    result.requires_system_settings |= warnings.iter().any(|warning| {
        warning.source == StartupItemSource::BackgroundTask
            && warning.issue == StartupScanIssue::SourceUnavailable
    });
    result
}

fn evaluate_startup_management(
    requested_item: &StartupItem,
    expected_enabled: bool,
    items: &[StartupItem],
) -> StartupVerificationResult {
    let target_confirmed = items
        .iter()
        .find(|item| item.id == requested_item.id)
        .is_some_and(|item| item.enabled == expected_enabled);
    if !target_confirmed {
        return StartupVerificationResult {
            status: StartupManagementVerification::NotConfirmed,
            related_item_count: 0,
            unresolved_source_count: 0,
            requires_system_settings: false,
        };
    }

    let conflicting_items = items.iter().filter(|item| {
        if item.id == requested_item.id
            || item.system
            || !startup_items_represent_same_application(requested_item, item)
        {
            return false;
        }
        if expected_enabled {
            !item.enabled && item.management_status != StartupManagementStatus::Available
        } else {
            item.enabled
        }
    });
    let conflicts = conflicting_items.collect::<Vec<_>>();
    StartupVerificationResult {
        status: if conflicts.is_empty() {
            StartupManagementVerification::Complete
        } else {
            StartupManagementVerification::Partial
        },
        related_item_count: conflicts.len(),
        unresolved_source_count: 0,
        requires_system_settings: conflicts
            .iter()
            .any(|item| item.management_status != StartupManagementStatus::Available),
    }
}

fn startup_items_represent_same_application(left: &StartupItem, right: &StartupItem) -> bool {
    if left
        .bundle_id
        .as_deref()
        .zip(right.bundle_id.as_deref())
        .is_some_and(|(left_bundle, right_bundle)| left_bundle.eq_ignore_ascii_case(right_bundle))
    {
        return true;
    }
    #[cfg(target_os = "macos")]
    if left
        .executable_path
        .as_deref()
        .and_then(|path| containing_app_bundle(Path::new(path)))
        .zip(
            right
                .executable_path
                .as_deref()
                .and_then(|path| containing_app_bundle(Path::new(path))),
        )
        .is_some_and(|(left_app, right_app)| {
            left_app
                .to_string_lossy()
                .eq_ignore_ascii_case(&right_app.to_string_lossy())
        })
    {
        return true;
    }
    let left_name = normalize_startup_identity(&left.name);
    !left_name.is_empty() && left_name == normalize_startup_identity(&right.name)
}

fn normalize_startup_identity(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(target_os = "macos")]
fn targeted_startup_item(item_id: &str, home: &Path) -> Option<StartupItem> {
    let original = PathBuf::from(item_id.strip_prefix("launch-agent:")?);
    let user_directory = home.join("Library/LaunchAgents");
    let scope = if original.parent() == Some(user_directory.as_path()) {
        StartupItemScope::User
    } else {
        StartupItemScope::System
    };
    if original.exists() {
        return macos_startup_item(
            &original,
            &original,
            StartupItemSource::LaunchAgent,
            scope,
            false,
        );
    }
    let file_name = original.file_name()?;
    macos_disabled_directories(home)
        .into_iter()
        .find_map(|directory| {
            let disabled = directory.join(file_name);
            disabled
                .exists()
                .then(|| {
                    macos_startup_item(
                        &disabled,
                        &original,
                        StartupItemSource::LaunchAgent,
                        StartupItemScope::User,
                        true,
                    )
                })
                .flatten()
        })
}

#[cfg(target_os = "linux")]
fn targeted_startup_item(item_id: &str, home: &Path) -> Option<StartupItem> {
    let original = PathBuf::from(item_id.strip_prefix("desktop-entry:")?);
    let user_directory = home.join(".config/autostart");
    let scope = if original.parent() == Some(user_directory.as_path()) {
        StartupItemScope::User
    } else {
        StartupItemScope::System
    };
    if original.exists() {
        return linux_desktop_item(&original, &original, scope, false);
    }
    let file_name = original.file_name()?;
    linux_disabled_directories(home)
        .into_iter()
        .find_map(|directory| {
            let disabled = directory.join(file_name);
            disabled
                .exists()
                .then(|| linux_desktop_item(&disabled, &original, StartupItemScope::User, true))
                .flatten()
        })
}

#[cfg(windows)]
fn targeted_startup_item(item_id: &str, home: &Path) -> Option<StartupItem> {
    let original = PathBuf::from(item_id.strip_prefix("startup-folder:")?);
    let active = original.exists().then(|| original.clone());
    let disabled = original.file_name().and_then(|file_name| {
        windows_disabled_directories(home)
            .into_iter()
            .map(|directory| directory.join(file_name))
            .find(|candidate| candidate.exists())
    });
    let (source, enabled) = active
        .map(|path| (path, true))
        .or_else(|| disabled.map(|path| (path, false)))?;
    Some(StartupItem {
        id: item_id.to_owned(),
        name: original.file_stem()?.to_string_lossy().into_owned(),
        publisher: None,
        command: Some(original.to_string_lossy().into_owned()),
        path: original.to_string_lossy().into_owned(),
        source: StartupItemSource::StartupFolder,
        scope: StartupItemScope::User,
        enabled,
        system: false,
        launch_kind: StartupLaunchKind::Login,
        management_status: StartupManagementStatus::Available,
        bundle_id: None,
        team_id: None,
        signature_status: None,
        executable_path: Some(source.to_string_lossy().into_owned()),
        responsible_application: None,
        last_run_status: None,
        orphaned: false,
        modern_background_item: false,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn targeted_startup_item(_item_id: &str, _home: &Path) -> Option<StartupItem> {
    None
}

pub fn scan_startup_items() -> Result<StartupItemsSnapshot, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    Ok(startup_items_snapshot_for_home(&home))
}

fn startup_items_snapshot_for_home(home: &Path) -> StartupItemsSnapshot {
    let (mut items, scan_warnings) = platform_startup_items(home);
    let unreadable_location_count = scan_warnings.iter().map(|warning| warning.count).sum();
    items.sort_by(|left, right| {
        left.system
            .cmp(&right.system)
            .then_with(|| right.enabled.cmp(&left.enabled))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let management_available = items
        .iter()
        .any(|item| item.management_status == StartupManagementStatus::Available);
    StartupItemsSnapshot {
        sampled_at_ms: now_millis(),
        items,
        unreadable_location_count,
        scan_warnings,
        management_available,
    }
}

fn push_startup_warning(
    warnings: &mut Vec<StartupScanWarning>,
    source: StartupItemSource,
    issue: StartupScanIssue,
    count: usize,
) {
    if count == 0 {
        return;
    }
    if let Some(existing) = warnings
        .iter_mut()
        .find(|warning| warning.source == source && warning.issue == issue)
    {
        existing.count += count;
    } else {
        warnings.push(StartupScanWarning {
            source,
            issue,
            count,
        });
    }
}

#[cfg(target_os = "macos")]
fn platform_startup_items(home: &Path) -> (Vec<StartupItem>, Vec<StartupScanWarning>) {
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
    let mut warnings = Vec::new();
    for (directory, source, scope) in definitions {
        match scan_macos_plists(&directory, &directory, source, scope, false) {
            Ok((mut found, invalid)) => {
                items.append(&mut found);
                push_startup_warning(
                    &mut warnings,
                    source,
                    StartupScanIssue::InvalidEntry,
                    invalid,
                );
            }
            Err(()) if directory.exists() => push_startup_warning(
                &mut warnings,
                source,
                StartupScanIssue::UnreadableLocation,
                1,
            ),
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
            Ok((found, invalid)) => {
                append_unique_startup_items(&mut items, found);
                push_startup_warning(
                    &mut warnings,
                    StartupItemSource::LaunchAgent,
                    StartupScanIssue::InvalidEntry,
                    invalid,
                );
            }
            Err(()) if disabled_launch_agents.exists() => push_startup_warning(
                &mut warnings,
                StartupItemSource::LaunchAgent,
                StartupScanIssue::UnreadableLocation,
                1,
            ),
            Err(()) => {}
        }
    }
    #[cfg(not(test))]
    {
        match scan_macos_background_tasks() {
            Ok(mut modern_items) => append_unique_startup_items(&mut items, modern_items.drain(..)),
            Err(()) => push_startup_warning(
                &mut warnings,
                StartupItemSource::BackgroundTask,
                StartupScanIssue::SourceUnavailable,
                1,
            ),
        }
    }
    (items, warnings)
}

#[cfg(target_os = "macos")]
fn scan_macos_plists(
    directory: &Path,
    original_directory: &Path,
    source: StartupItemSource,
    scope: StartupItemScope,
    managed_disabled: bool,
) -> Result<(Vec<StartupItem>, usize), ()> {
    let entries = fs::read_dir(directory).map_err(|_| ())?;
    let mut items = Vec::new();
    let mut invalid = 0;
    for entry in entries {
        let Ok(entry) = entry else {
            invalid += 1;
            continue;
        };
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "plist")
        {
            continue;
        }
        let original_path = original_directory.join(entry.file_name());
        match macos_startup_item(
            &entry.path(),
            &original_path,
            source,
            scope,
            managed_disabled,
        ) {
            Some(item) => items.push(item),
            None => invalid += 1,
        }
    }
    Ok((items, invalid))
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
    let ownership = macos_startup_ownership(program.as_deref(), &label);
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
        bundle_id: ownership.bundle_id,
        team_id: ownership.team_id,
        signature_status: ownership.signature_status,
        executable_path: ownership.executable_path,
        responsible_application: ownership.responsible_application,
        last_run_status: None,
        orphaned: ownership.orphaned,
        modern_background_item: false,
    })
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct MacosStartupOwnership {
    bundle_id: Option<String>,
    team_id: Option<String>,
    signature_status: Option<String>,
    executable_path: Option<String>,
    responsible_application: Option<String>,
    orphaned: bool,
}

#[cfg(target_os = "macos")]
fn macos_startup_ownership(program: Option<&str>, label: &str) -> MacosStartupOwnership {
    let executable = program.and_then(command_executable).map(PathBuf::from);
    let app_bundle = executable.as_deref().and_then(containing_app_bundle);
    let bundle_id = app_bundle.as_deref().and_then(macos_bundle_id);
    let responsible_application = app_bundle
        .as_deref()
        .and_then(Path::file_stem)
        .map(|value| value.to_string_lossy().into_owned())
        .or_else(|| publisher_from_label(label));
    let (team_id, signature_status) = app_bundle
        .as_deref()
        .map(macos_signature_metadata)
        .unwrap_or((None, None));
    let orphaned = executable.as_deref().is_some_and(|path| !path.exists());
    MacosStartupOwnership {
        bundle_id,
        team_id,
        signature_status,
        executable_path: executable.map(|path| path.to_string_lossy().into_owned()),
        responsible_application,
        orphaned,
    }
}

#[cfg(target_os = "macos")]
fn command_executable(command: &str) -> Option<&str> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.split('"').next().filter(|value| !value.is_empty());
    }
    Some(trimmed.split_whitespace().next().unwrap_or(trimmed))
}

#[cfg(target_os = "macos")]
fn containing_app_bundle(path: &Path) -> Option<PathBuf> {
    let mut candidate = PathBuf::new();
    for component in path.components() {
        candidate.push(component.as_os_str());
        if candidate
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        {
            return Some(candidate);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_bundle_id(app: &Path) -> Option<String> {
    let value = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    value
        .as_dictionary()?
        .get("CFBundleIdentifier")?
        .as_string()
        .map(str::to_owned)
}

#[cfg(target_os = "macos")]
fn macos_signature_metadata(app: &Path) -> (Option<String>, Option<String>) {
    let mut command = Command::new("/usr/bin/codesign");
    command.args(["-dv", "--verbose=4"]).arg(app);
    match bounded_command::output(&mut command, STARTUP_METADATA_TIMEOUT, 256 * 1_024) {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stderr);
            let team_id = text.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("TeamIdentifier=")
                    .and_then(|value| {
                        (!value.is_empty() && value != "not set").then(|| value.to_owned())
                    })
            });
            let status = if output.status.success() {
                Some("valid".to_owned())
            } else {
                Some("invalid".to_owned())
            };
            (team_id, status)
        }
        Err(_) => (None, Some("unknown".to_owned())),
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn scan_macos_background_tasks() -> Result<Vec<StartupItem>, ()> {
    let mut command = Command::new("/usr/bin/sfltool");
    command.arg("dumpbtm");
    let output = bounded_command::output_with_circuit(
        "startup.sfltool",
        &mut command,
        STARTUP_METADATA_TIMEOUT,
        2 * 1_024 * 1_024,
    )
    .map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    Ok(parse_macos_background_tasks(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(target_os = "macos")]
fn parse_macos_background_tasks(text: &str) -> Vec<StartupItem> {
    let mut blocks = Vec::<Vec<(&str, &str)>>::new();
    let mut current = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("UUID:") && !current.is_empty() {
            blocks.push(std::mem::take(&mut current));
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            current.push((key.trim(), value.trim()));
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
        .into_iter()
        .filter_map(|block| {
            let field = |names: &[&str]| {
                block
                    .iter()
                    .find_map(|(key, value)| names.contains(key).then(|| (*value).to_owned()))
            };
            let name = field(&["Name", "Developer Name"])?;
            let bundle_id = field(&["Identifier", "Bundle Identifier"]);
            let executable_path = field(&["Executable Path", "Path"]);
            let url = field(&["URL"]);
            let path = executable_path.clone().or(url).unwrap_or_default();
            if path.is_empty() {
                return None;
            }
            let item_type = field(&["Type"]).unwrap_or_default();
            let disposition = field(&["Disposition"]).unwrap_or_default();
            let team_id = field(&["Team Identifier", "Team ID"]);
            let protected = bundle_id
                .as_deref()
                .is_some_and(|identifier| identifier.starts_with("com.apple."));
            Some(StartupItem {
                id: format!(
                    "background-task:{}:{}",
                    bundle_id.as_deref().unwrap_or(&name),
                    path
                ),
                name: name.clone(),
                publisher: field(&["Developer Name"]),
                command: executable_path.clone(),
                path: path.clone(),
                source: StartupItemSource::BackgroundTask,
                scope: StartupItemScope::User,
                enabled: !disposition.to_lowercase().contains("disabled"),
                system: protected,
                launch_kind: if item_type.to_lowercase().contains("login item") {
                    StartupLaunchKind::Login
                } else {
                    StartupLaunchKind::Conditional
                },
                management_status: if protected {
                    StartupManagementStatus::Protected
                } else {
                    StartupManagementStatus::Unsupported
                },
                bundle_id,
                team_id,
                signature_status: field(&["Signature Status"])
                    .or_else(|| Some("system_reported".to_owned())),
                executable_path: executable_path.clone(),
                responsible_application: Some(name),
                last_run_status: field(&["Status", "Last Run"]),
                orphaned: executable_path
                    .as_deref()
                    .is_some_and(|candidate| !Path::new(candidate).exists()),
                modern_background_item: true,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn platform_startup_items(home: &Path) -> (Vec<StartupItem>, Vec<StartupScanWarning>) {
    let user_autostart = home.join(".config/autostart");
    let definitions = [
        (user_autostart.clone(), StartupItemScope::User),
        (
            PathBuf::from("/etc/xdg/autostart"),
            StartupItemScope::System,
        ),
    ];
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for (directory, scope) in definitions {
        match scan_linux_desktop_entries(&directory, &directory, scope, false) {
            Ok((mut found, invalid)) => {
                items.append(&mut found);
                push_startup_warning(
                    &mut warnings,
                    StartupItemSource::DesktopEntry,
                    StartupScanIssue::InvalidEntry,
                    invalid,
                );
            }
            Err(()) if directory.exists() => push_startup_warning(
                &mut warnings,
                StartupItemSource::DesktopEntry,
                StartupScanIssue::UnreadableLocation,
                1,
            ),
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
            Ok((found, invalid)) => {
                append_unique_startup_items(&mut items, found);
                push_startup_warning(
                    &mut warnings,
                    StartupItemSource::DesktopEntry,
                    StartupScanIssue::InvalidEntry,
                    invalid,
                );
            }
            Err(()) if disabled_autostart.exists() => push_startup_warning(
                &mut warnings,
                StartupItemSource::DesktopEntry,
                StartupScanIssue::UnreadableLocation,
                1,
            ),
            Err(()) => {}
        }
    }
    (items, warnings)
}

#[cfg(target_os = "linux")]
fn scan_linux_desktop_entries(
    directory: &Path,
    original_directory: &Path,
    scope: StartupItemScope,
    managed_disabled: bool,
) -> Result<(Vec<StartupItem>, usize), ()> {
    let entries = fs::read_dir(directory).map_err(|_| ())?;
    let mut items = Vec::new();
    let mut invalid = 0;
    for entry in entries {
        let Ok(entry) = entry else {
            invalid += 1;
            continue;
        };
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "desktop")
        {
            continue;
        }
        let original_path = original_directory.join(entry.file_name());
        match linux_desktop_item(&entry.path(), &original_path, scope, managed_disabled) {
            Some(item) => items.push(item),
            None => invalid += 1,
        }
    }
    Ok((items, invalid))
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
        bundle_id: None,
        team_id: None,
        signature_status: None,
        executable_path: field("Exec")
            .and_then(|value| value.split_whitespace().next().map(str::to_owned)),
        responsible_application: None,
        last_run_status: None,
        orphaned: false,
        modern_background_item: false,
    })
}

#[cfg(windows)]
fn platform_startup_items(home: &Path) -> (Vec<StartupItem>, Vec<StartupScanWarning>) {
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
    let mut warnings = Vec::new();
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
                        bundle_id: None,
                        team_id: None,
                        signature_status: None,
                        executable_path: Some(command.trim().to_owned()),
                        responsible_application: None,
                        last_run_status: None,
                        orphaned: false,
                        modern_background_item: false,
                    });
                }
            }
            Ok(_) | Err(_) => push_startup_warning(
                &mut warnings,
                StartupItemSource::RegistryRun,
                StartupScanIssue::SourceUnavailable,
                1,
            ),
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
                        bundle_id: None,
                        team_id: None,
                        signature_status: None,
                        executable_path: Some(entry.path().to_string_lossy().into_owned()),
                        responsible_application: None,
                        last_run_status: None,
                        orphaned: false,
                        modern_background_item: false,
                    }
                }));
            }
            Err(_) if directory.exists() => push_startup_warning(
                &mut warnings,
                StartupItemSource::StartupFolder,
                StartupScanIssue::UnreadableLocation,
                1,
            ),
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
                            bundle_id: None,
                            team_id: None,
                            signature_status: None,
                            executable_path: Some(original_path.to_string_lossy().into_owned()),
                            responsible_application: None,
                            last_run_status: None,
                            orphaned: false,
                            modern_background_item: false,
                        }
                    });
                    append_unique_startup_items(&mut items, found);
                }
                Err(_) if disabled_directory.exists() => push_startup_warning(
                    &mut warnings,
                    StartupItemSource::StartupFolder,
                    StartupScanIssue::UnreadableLocation,
                    1,
                ),
                Err(_) => {}
            }
        }
    }
    (items, warnings)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_startup_items(_home: &Path) -> (Vec<StartupItem>, Vec<StartupScanWarning>) {
    (Vec::new(), Vec::new())
}

#[cfg(target_os = "macos")]
fn macos_disabled_directories(home: &Path) -> [PathBuf; 2] {
    [
        home.join("Library/Application Support/CoreRobin/Disabled Startup Items/LaunchAgents"),
        home.join("Library/Application Support/Pulse/Disabled Startup Items/LaunchAgents"),
    ]
}

#[cfg(target_os = "linux")]
fn linux_disabled_directories(home: &Path) -> [PathBuf; 2] {
    [
        home.join(".local/share/core-robin/disabled-startup/autostart"),
        home.join(".local/share/pulse/disabled-startup/autostart"),
    ]
}

#[cfg(windows)]
fn windows_disabled_directories(home: &Path) -> [PathBuf; 2] {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    [
        local_app_data.join("CoreRobin/Disabled Startup Items/Startup"),
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
            "CoreRobin only manages user LaunchAgent files from the standard folder.",
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
            "CoreRobin only manages user desktop autostart files from the standard folder.",
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
            "CoreRobin only manages files in the current user's Startup folder on Windows.",
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
                "The startup file is outside the current user's profile. CoreRobin changed nothing.",
            )
        })
}

fn map_startup_binding_error(error: io::Error) -> CommandError {
    match error.kind() {
        io::ErrorKind::AlreadyExists => CommandError::new(
            "startup_destination_conflict",
            "Another startup configuration already exists at the destination. CoreRobin changed nothing.",
        ),
        io::ErrorKind::NotFound => CommandError::new(
            "startup_item_unavailable",
            format!("The startup file or its parent is no longer available: {error}"),
        ),
        io::ErrorKind::InvalidData | io::ErrorKind::PermissionDenied => CommandError::new(
            "startup_item_protected",
            format!("CoreRobin refused an unsafe startup file operation: {error}"),
        ),
        _ => CommandError::new(
            "startup_management_failed",
            format!("CoreRobin could not safely bind the startup file: {error}"),
        ),
    }
}

fn map_startup_move_error(error: io::Error) -> CommandError {
    match error.kind() {
        io::ErrorKind::AlreadyExists => CommandError::new(
            "startup_destination_conflict",
            "Another startup configuration appeared at the destination. CoreRobin refused to overwrite it.",
        ),
        io::ErrorKind::NotFound | io::ErrorKind::InvalidData => CommandError::new(
            "startup_state_changed",
            format!("The startup source or destination changed. CoreRobin stopped safely: {error}"),
        ),
        _ => CommandError::new(
            "startup_management_failed",
            format!("CoreRobin could not safely move the startup configuration: {error}"),
        ),
    }
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(any(target_os = "macos", test))]
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
        StartupItemSource::BackgroundTask => "background-task",
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
        StartupItemSource, StartupManagementAction, StartupManagementExecutionRequest,
        StartupManagementLeaseRequest, StartupManagementStatus, StartupManagementVerification,
        StartupScanIssue, StartupScanWarning,
    };

    #[cfg(target_os = "macos")]
    use super::{
        StartupController, apply_startup_scan_warnings, evaluate_startup_management,
        macos_disabled_directories, parse_macos_background_tasks, platform_startup_items,
    };
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
    fn parses_modern_background_task_ownership_as_read_only() {
        let items = parse_macos_background_tasks(
            r#"
UUID: A1
Name: Example Helper
Developer Name: Example Inc
Identifier: com.example.helper
Team Identifier: TEAM123
Type: curated legacy login item
Disposition: [enabled, allowed, visible]
Executable Path: /Applications/Example.app/Contents/Library/LoginItems/Helper.app/Contents/MacOS/Helper
"#,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].bundle_id.as_deref(), Some("com.example.helper"));
        assert_eq!(items[0].team_id.as_deref(), Some("TEAM123"));
        assert!(items[0].modern_background_item);
        assert_eq!(
            items[0].management_status,
            StartupManagementStatus::Unsupported
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
        assert_eq!(
            disabled_result.verification,
            StartupManagementVerification::Complete
        );
        assert_eq!(disabled_result.related_item_count, 0);
        assert_eq!(disabled_result.unresolved_source_count, 0);
        assert!(!disabled_result.requires_system_settings);
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
    fn startup_management_reports_related_enabled_sources_as_partial() {
        let root = test_root("partial-related-source");
        let active = write_launch_agent(&root, "com.example.primary.plist", "com.example.primary");
        write_launch_agent(
            &root,
            "com.example.secondary.plist",
            "com.example.secondary",
        );
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

        let result = controller
            .execute(StartupManagementExecutionRequest { lease_id: lease.id })
            .unwrap();

        assert!(!result.enabled);
        assert_eq!(result.verification, StartupManagementVerification::Partial);
        assert_eq!(result.related_item_count, 1);
        assert_eq!(result.unresolved_source_count, 0);
        assert!(!result.requires_system_settings);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_management_routes_unsupported_related_sources_to_system_settings() {
        let root = test_root("partial-unsupported-source");
        let active = write_launch_agent(&root, "com.example.primary.plist", "com.example.primary");
        let (items, _) = platform_startup_items(&root);
        let requested = items
            .into_iter()
            .find(|item| item.path == active.to_string_lossy())
            .unwrap();
        let mut observed = requested.clone();
        observed.enabled = false;
        let mut unsupported = requested.clone();
        unsupported.id = "background-task:com.example.primary".to_owned();
        unsupported.source = StartupItemSource::BackgroundTask;
        unsupported.management_status = StartupManagementStatus::Unsupported;
        unsupported.modern_background_item = true;

        let result = evaluate_startup_management(&requested, false, &[observed, unsupported]);

        assert_eq!(result.status, StartupManagementVerification::Partial);
        assert_eq!(result.related_item_count, 1);
        assert_eq!(result.unresolved_source_count, 0);
        assert!(result.requires_system_settings);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_management_does_not_claim_complete_when_a_source_is_unavailable() {
        let result = apply_startup_scan_warnings(
            super::StartupVerificationResult {
                status: StartupManagementVerification::Complete,
                related_item_count: 0,
                unresolved_source_count: 0,
                requires_system_settings: false,
            },
            &[StartupScanWarning {
                source: StartupItemSource::BackgroundTask,
                issue: StartupScanIssue::SourceUnavailable,
                count: 1,
            }],
        );

        assert_eq!(result.status, StartupManagementVerification::Partial);
        assert_eq!(result.unresolved_source_count, 1);
        assert!(result.requires_system_settings);
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
            "core-robin-startup-{name}-{}-{}",
            std::process::id(),
            super::now_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }
}
