#![cfg_attr(target_os = "macos", allow(dead_code))]

use std::collections::HashMap;
#[cfg(any(windows, target_os = "linux"))]
use std::process::Command;
use std::process::ExitStatus;
use std::sync::{Mutex, OnceLock};
#[cfg(any(windows, target_os = "linux"))]
use std::time::Duration;

use std::fs;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[cfg(any(windows, target_os = "linux"))]
use crate::bounded_command;
use crate::error::CommandError;
use crate::models::{
    ApplicationInstallationSource, ApplicationInventorySnapshot, ApplicationUninstallPlan,
    InstalledApplication, NativeApplicationUninstallExecutionRequest,
    NativeApplicationUninstallOutcome, NativeApplicationUninstallPlan,
    NativeApplicationUninstallResult,
};

const PLAN_TTL_MS: u64 = 10 * 60 * 1_000;
const INVENTORY_CACHE_TTL_MS: u64 = 5 * 60 * 1_000;
#[cfg(any(windows, target_os = "linux"))]
const INVENTORY_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(windows, target_os = "linux"))]
const INVENTORY_COMMAND_OUTPUT_LIMIT: usize = 8 * 1_024 * 1_024;

#[derive(Clone)]
struct StoredPlan {
    created_at_ms: u64,
    source: ApplicationInstallationSource,
    identifier: String,
}

static NATIVE_UNINSTALL_PLANS: OnceLock<Mutex<HashMap<String, StoredPlan>>> = OnceLock::new();

#[derive(Clone)]
struct NativeInventoryCache {
    language: String,
    fingerprint: Option<String>,
    stored_at_ms: u64,
    snapshot: ApplicationInventorySnapshot,
}

static NATIVE_INVENTORY_CACHE: OnceLock<Mutex<Option<NativeInventoryCache>>> = OnceLock::new();

pub fn load_or_scan_native_application_inventory(
    preferred_language: Option<&str>,
    force_refresh: bool,
) -> Result<ApplicationInventorySnapshot, CommandError> {
    let language = preferred_language.unwrap_or("en").to_ascii_lowercase();
    let fingerprint = native_inventory_fingerprint();
    let now = now_millis();
    let cache = NATIVE_INVENTORY_CACHE.get_or_init(|| Mutex::new(None));
    if !force_refresh
        && let Ok(cache) = cache.lock()
        && let Some(cached) = cache.as_ref()
        && cached.language == language
        && cached.fingerprint == fingerprint
        && now.saturating_sub(cached.stored_at_ms) <= INVENTORY_CACHE_TTL_MS
    {
        let mut snapshot = cached.snapshot.clone();
        snapshot.cached = true;
        snapshot.refresh_recommended =
            now.saturating_sub(cached.stored_at_ms) > INVENTORY_CACHE_TTL_MS / 2;
        return Ok(snapshot);
    }
    let snapshot = scan_native_application_inventory(preferred_language)?;
    if let Ok(mut cache) = cache.lock() {
        *cache = Some(NativeInventoryCache {
            language,
            fingerprint,
            stored_at_ms: now,
            snapshot: snapshot.clone(),
        });
    }
    Ok(snapshot)
}

pub fn scan_native_application_inventory(
    preferred_language: Option<&str>,
) -> Result<ApplicationInventorySnapshot, CommandError> {
    #[cfg(windows)]
    return scan_windows_inventory();

    #[cfg(target_os = "linux")]
    return scan_linux_inventory(preferred_language);

    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = preferred_language;
        Ok(ApplicationInventorySnapshot {
            sampled_at_ms: now_millis(),
            platform_supported: false,
            cached: false,
            refresh_recommended: false,
            applications: Vec::new(),
        })
    }
}

pub fn prepare_native_application_uninstall(
    application_path: &str,
    preferred_language: Option<&str>,
) -> Result<ApplicationUninstallPlan, CommandError> {
    let inventory = load_or_scan_native_application_inventory(preferred_language, false)?;
    let application = inventory
        .applications
        .into_iter()
        .find(|application| application.path == application_path)
        .ok_or_else(|| {
            CommandError::new(
                "application_unavailable",
                "The application is no longer present in the operating system package catalog.",
            )
        })?;
    if !application.uninstallable {
        return Err(CommandError::new(
            application
                .unavailable_reason
                .clone()
                .unwrap_or_else(|| "application_uninstall_unavailable".to_owned()),
            "The operating system does not expose a trusted uninstall method for this application.",
        ));
    }
    let identifier = application
        .native_uninstall_identifier
        .clone()
        .ok_or_else(|| {
            CommandError::new(
                "application_identity_unavailable",
                "The package catalog did not provide a stable uninstall identity.",
            )
        })?;
    validate_native_identifier(application.installation_source, &identifier)?;
    let source = application.installation_source;
    let requires_elevation = application.native_uninstall_requires_elevation;
    let id = random_plan_id()?;
    let plan = StoredPlan {
        created_at_ms: now_millis(),
        source: application.installation_source,
        identifier: identifier.clone(),
    };
    let mut plans = plan_store()
        .lock()
        .map_err(|_| CommandError::internal("The native uninstall plan store is unavailable."))?;
    plans.retain(|_, plan| now_millis().saturating_sub(plan.created_at_ms) <= PLAN_TTL_MS);
    plans.insert(id.clone(), plan);
    Ok(ApplicationUninstallPlan {
        sampled_at_ms: now_millis(),
        application,
        artifacts: Vec::new(),
        skipped_paths: Vec::new(),
        native_uninstall: Some(NativeApplicationUninstallPlan {
            id,
            source,
            identifier,
            method: native_method_label(source).to_owned(),
            requires_elevation,
        }),
    })
}

pub fn execute_native_application_uninstall(
    request: NativeApplicationUninstallExecutionRequest,
) -> Result<NativeApplicationUninstallResult, CommandError> {
    let mut plans = plan_store()
        .lock()
        .map_err(|_| CommandError::internal("The native uninstall plan store is unavailable."))?;
    let stored = take_plan(&mut plans, &request.plan_id, now_millis())?;
    drop(plans);
    if !native_identity_is_current(stored.source, &stored.identifier)? {
        return Err(CommandError::new(
            "application_identity_changed",
            "The operating system uninstall identity changed. Prepare a new plan.",
        ));
    }
    let status = execute_fixed_native_uninstaller(stored.source, &stored.identifier)?;
    invalidate_native_inventory_cache();
    Ok(result_from_status(status))
}

fn invalidate_native_inventory_cache() {
    if let Some(cache) = NATIVE_INVENTORY_CACHE.get()
        && let Ok(mut cache) = cache.lock()
    {
        *cache = None;
    }
}

fn plan_store() -> &'static Mutex<HashMap<String, StoredPlan>> {
    NATIVE_UNINSTALL_PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn take_plan(
    plans: &mut HashMap<String, StoredPlan>,
    plan_id: &str,
    now: u64,
) -> Result<StoredPlan, CommandError> {
    let plan = plans.remove(plan_id).ok_or_else(|| {
        CommandError::new(
            "native_uninstall_plan_expired",
            "The native uninstall plan is unavailable. Prepare the application again.",
        )
    })?;
    if now.saturating_sub(plan.created_at_ms) > PLAN_TTL_MS {
        return Err(CommandError::new(
            "native_uninstall_plan_expired",
            "The native uninstall plan expired. Prepare the application again.",
        ));
    }
    Ok(plan)
}

fn random_plan_id() -> Result<String, CommandError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| {
        CommandError::internal(format!("Could not create a native uninstall plan: {error}"))
    })?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn native_method_label(source: ApplicationInstallationSource) -> &'static str {
    match source {
        ApplicationInstallationSource::WindowsMsi => "Windows Installer (MSI)",
        ApplicationInstallationSource::WindowsMsix => "Windows package catalog (MSIX)",
        ApplicationInstallationSource::WindowsUninstaller => "Registered Windows uninstaller",
        ApplicationInstallationSource::LinuxFlatpak => "Flatpak",
        ApplicationInstallationSource::LinuxDeb => "APT / dpkg",
        ApplicationInstallationSource::LinuxRpm => "DNF / RPM",
        ApplicationInstallationSource::LinuxSnap => "Snap",
        _ => "Operating system package manager",
    }
}

fn validate_native_identifier(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<(), CommandError> {
    let safe_package = !identifier.is_empty()
        && identifier.len() <= 255
        && identifier.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '-' | '_' | '+' | ':' | '@')
        });
    let valid = match source {
        ApplicationInstallationSource::WindowsMsi => {
            identifier.len() == 38
                && identifier.starts_with('{')
                && identifier.ends_with('}')
                && identifier[1..identifier.len() - 1]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit() || character == '-')
        }
        ApplicationInstallationSource::WindowsMsix => safe_package,
        ApplicationInstallationSource::LinuxFlatpak => {
            let value = identifier
                .strip_prefix("user:")
                .or_else(|| identifier.strip_prefix("system:"))
                .unwrap_or(identifier);
            !value.is_empty()
                && value.len() <= 255
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
                })
        }
        ApplicationInstallationSource::LinuxDeb
        | ApplicationInstallationSource::LinuxRpm
        | ApplicationInstallationSource::LinuxSnap => safe_package,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            "application_identity_invalid",
            "The package catalog returned an invalid uninstall identity.",
        ))
    }
}

fn result_from_status(status: ExitStatus) -> NativeApplicationUninstallResult {
    let exit_code = status.code();
    let outcome = outcome_from_exit(status.success(), exit_code);
    NativeApplicationUninstallResult {
        outcome,
        exit_code,
        message: match outcome {
            NativeApplicationUninstallOutcome::Succeeded => {
                "The operating system completed the uninstall request.".to_owned()
            }
            NativeApplicationUninstallOutcome::Cancelled => {
                "The operating system uninstall request was cancelled.".to_owned()
            }
            NativeApplicationUninstallOutcome::RestartRequired => {
                "The application was removed and the operating system requested a restart."
                    .to_owned()
            }
            NativeApplicationUninstallOutcome::Failed => format!(
                "The operating system uninstaller exited with code {}.",
                exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_owned()),
            ),
        },
    }
}

fn outcome_from_exit(success: bool, exit_code: Option<i32>) -> NativeApplicationUninstallOutcome {
    if success {
        NativeApplicationUninstallOutcome::Succeeded
    } else if matches!(exit_code, Some(126 | 1602)) {
        NativeApplicationUninstallOutcome::Cancelled
    } else if matches!(exit_code, Some(1641 | 3010)) {
        NativeApplicationUninstallOutcome::RestartRequired
    } else {
        NativeApplicationUninstallOutcome::Failed
    }
}

#[cfg(windows)]
fn native_inventory_fingerprint() -> Option<String> {
    // Registry providers do not expose a cheap stable catalog generation.
    // The short cache TTL remains the Windows invalidation boundary.
    None
}

#[cfg(target_os = "linux")]
fn native_inventory_fingerprint() -> Option<String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    for path in [
        "/usr/share/applications",
        "/usr/local/share/applications",
        "/var/lib/flatpak/exports/share/applications",
        "/var/lib/snapd/desktop/applications",
        "/var/lib/dpkg/status",
        "/var/lib/rpm",
        "/usr/lib/sysimage/rpm",
    ] {
        path.hash(&mut hasher);
        if let Ok(metadata) = fs::metadata(path) {
            metadata.len().hash(&mut hasher);
            metadata
                .modified()
                .ok()
                .and_then(system_time_millis)
                .hash(&mut hasher);
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for path in [
            home.join(".local/share/applications"),
            home.join(".local/share/flatpak/exports/share/applications"),
        ] {
            path.hash(&mut hasher);
            if let Ok(metadata) = fs::metadata(&path) {
                metadata.len().hash(&mut hasher);
                metadata
                    .modified()
                    .ok()
                    .and_then(system_time_millis)
                    .hash(&mut hasher);
            }
        }
    }
    Some(format!("{:016x}", hasher.finish()))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn native_inventory_fingerprint() -> Option<String> {
    None
}

#[cfg(windows)]
fn native_identity_is_current(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<bool, CommandError> {
    validate_native_identifier(source, identifier)?;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command"]);
    match source {
        ApplicationInstallationSource::WindowsMsi => {
            command.arg(
                "$id=$env:CORE_ROBIN_PACKAGE_ID; $roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); if ($roots | Where-Object { Test-Path (Join-Path $_ $id) }) { exit 0 } else { exit 1 }",
            );
        }
        ApplicationInstallationSource::WindowsMsix => {
            command.arg(
                "if (Get-AppxPackage -Package $env:CORE_ROBIN_PACKAGE_ID -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
            );
        }
        _ => return Ok(false),
    }
    command.env("CORE_ROBIN_PACKAGE_ID", identifier);
    command_success(&mut command, "Windows package identity")
}

#[cfg(target_os = "linux")]
fn native_identity_is_current(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<bool, CommandError> {
    validate_native_identifier(source, identifier)?;
    let mut command = match source {
        ApplicationInstallationSource::LinuxFlatpak => {
            let (scope, package) = identifier.split_once(':').ok_or_else(|| {
                CommandError::new(
                    "application_identity_invalid",
                    "The Flatpak identity did not include an installation scope.",
                )
            })?;
            let mut command = Command::new("flatpak");
            command.arg("info");
            command.arg(if scope == "user" {
                "--user"
            } else {
                "--system"
            });
            command.args(["--", package]);
            command
        }
        ApplicationInstallationSource::LinuxDeb => {
            let mut command = Command::new("dpkg-query");
            command.args(["-W", "-f=${db:Status-Status}", "--", identifier]);
            command
        }
        ApplicationInstallationSource::LinuxRpm => {
            let mut command = Command::new("rpm");
            command.args(["-q", "--", identifier]);
            command
        }
        ApplicationInstallationSource::LinuxSnap => {
            let mut command = Command::new("snap");
            command.args(["info", "--", identifier]);
            command
        }
        _ => return Ok(false),
    };
    command_success(&mut command, "Linux package identity")
}

#[cfg(not(any(windows, target_os = "linux")))]
fn native_identity_is_current(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<bool, CommandError> {
    let _ = (source, identifier);
    Ok(false)
}

#[cfg(any(windows, target_os = "linux"))]
fn command_success(command: &mut Command, context: &str) -> Result<bool, CommandError> {
    bounded_command::output(
        command,
        INVENTORY_COMMAND_TIMEOUT,
        INVENTORY_COMMAND_OUTPUT_LIMIT,
    )
    .map(|output| output.status.success())
    .map_err(|error| {
        CommandError::new(
            "application_inventory_unavailable",
            format!("{context} could not be checked: {error}"),
        )
    })
}

#[cfg(windows)]
fn scan_windows_inventory() -> Result<ApplicationInventorySnapshot, CommandError> {
    let script = r#"
$items = @()
$roots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($root in $roots) {
  Get-ItemProperty $root -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.DisplayName -and $_.SystemComponent -ne 1 -and $_.WindowsInstaller -eq 1 -and $_.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') {
      $items += [pscustomobject]@{ name=$_.DisplayName; id=$_.PSChildName; source='windows_msi'; size=([int64]$_.EstimatedSize * 1024); icon=$_.DisplayIcon }
    }
  }
}
Get-AppxPackage -PackageTypeFilter Main | Where-Object { -not $_.NonRemovable -and -not $_.IsFramework } | ForEach-Object {
  $items += [pscustomobject]@{ name=$_.Name; id=$_.PackageFullName; source='windows_msix'; size=0; icon=$null }
}
$items | Sort-Object name,id -Unique | ConvertTo-Json -Compress
"#;
    let output = bounded_command::output(
        Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]),
        INVENTORY_COMMAND_TIMEOUT,
        INVENTORY_COMMAND_OUTPUT_LIMIT,
    )
    .map_err(|error| {
        CommandError::internal(format!(
            "Could not read the Windows package catalog: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(CommandError::new(
            "application_inventory_unavailable",
            "Windows could not provide its installed application catalog.",
        ));
    }
    let mut applications = parse_windows_inventory(&output.stdout);
    sort_native_applications(&mut applications);
    Ok(native_inventory(applications))
}

fn parse_windows_inventory(bytes: &[u8]) -> Vec<InstalledApplication> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).unwrap_or_else(|_| serde_json::json!([]));
    let entries = match value {
        serde_json::Value::Array(entries) => entries,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.trim().to_owned();
            let identifier = entry.get("id")?.as_str()?.trim().to_owned();
            let source = match entry.get("source")?.as_str()? {
                "windows_msi" => ApplicationInstallationSource::WindowsMsi,
                "windows_msix" => ApplicationInstallationSource::WindowsMsix,
                _ => return None,
            };
            if validate_native_identifier(source, &identifier).is_err() {
                return None;
            }
            let protected = name.eq_ignore_ascii_case("CoreRobin");
            Some(native_application(
                name,
                source,
                identifier,
                entry
                    .get("size")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                entry
                    .get("icon")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                protected,
                source == ApplicationInstallationSource::WindowsMsi,
            ))
        })
        .collect()
}

#[cfg(windows)]
fn execute_fixed_native_uninstaller(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<ExitStatus, CommandError> {
    validate_native_identifier(source, identifier)?;
    let status = match source {
        ApplicationInstallationSource::WindowsMsi => Command::new("msiexec.exe")
            .args(["/x", identifier])
            .status(),
        ApplicationInstallationSource::WindowsMsix => Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Remove-AppxPackage -Package $env:CORE_ROBIN_PACKAGE_ID",
            ])
            .env("CORE_ROBIN_PACKAGE_ID", identifier)
            .status(),
        _ => {
            return Err(CommandError::new(
                "native_uninstall_method_unavailable",
                "This Windows install source is not supported.",
            ));
        }
    };
    status.map_err(|error| {
        CommandError::internal(format!("Could not start the Windows uninstaller: {error}"))
    })
}

#[cfg(target_os = "linux")]
fn scan_linux_inventory(
    preferred_language: Option<&str>,
) -> Result<ApplicationInventorySnapshot, CommandError> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut roots = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        PathBuf::from("/var/lib/snapd/desktop/applications"),
    ];
    if let Some(home) = home.as_ref() {
        roots.push(home.join(".local/share/applications"));
        roots.push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    let desktop_paths = roots
        .iter()
        .filter_map(|root| fs::read_dir(root).ok())
        .flat_map(|entries| entries.flatten().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("desktop"))
        .collect::<Vec<_>>();
    let deb_owners = deb_desktop_owners();
    let rpm_owners = rpm_desktop_owners(&desktop_paths);
    let mut applications = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in desktop_paths {
        let Some(desktop) = parse_desktop_entry(&path, preferred_language) else {
            continue;
        };
        if desktop.no_display {
            continue;
        }
        let (source, identifier, requires_elevation) = if let Some(identifier) = desktop.flatpak_id
        {
            let scope = if home
                .as_ref()
                .is_some_and(|home| path.starts_with(home.join(".local/share/flatpak")))
            {
                "user"
            } else {
                "system"
            };
            (
                ApplicationInstallationSource::LinuxFlatpak,
                format!("{scope}:{identifier}"),
                scope == "system",
            )
        } else if let Some(identifier) = desktop.snap_id {
            (ApplicationInstallationSource::LinuxSnap, identifier, true)
        } else if let Some(identifier) = deb_owners.get(&path) {
            (
                ApplicationInstallationSource::LinuxDeb,
                identifier.clone(),
                true,
            )
        } else if let Some(identifier) = rpm_owners.get(&path) {
            (
                ApplicationInstallationSource::LinuxRpm,
                identifier.clone(),
                true,
            )
        } else {
            (
                ApplicationInstallationSource::Portable,
                path.to_string_lossy().into_owned(),
                false,
            )
        };
        let identity = format!("{source:?}:{identifier}");
        if !seen.insert(identity) {
            continue;
        }
        let uninstallable = !matches!(source, ApplicationInstallationSource::Portable)
            && validate_native_identifier(source, &identifier).is_ok();
        let protected = desktop.name.eq_ignore_ascii_case("CoreRobin");
        let modified_at_ms = fs::metadata(&path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(system_time_millis);
        let mut application = native_application(
            desktop.name,
            source,
            identifier,
            0,
            desktop.icon_path,
            protected,
            requires_elevation,
        );
        application.modified_at_ms = modified_at_ms;
        if !uninstallable && !protected {
            application.uninstallable = false;
            application.unavailable_reason = Some("portable_application".to_owned());
        }
        applications.push(application);
    }
    sort_native_applications(&mut applications);
    Ok(native_inventory(applications))
}

struct DesktopEntry {
    name: String,
    no_display: bool,
    flatpak_id: Option<String>,
    snap_id: Option<String>,
    icon_path: Option<String>,
}

fn parse_desktop_entry(path: &Path, preferred_language: Option<&str>) -> Option<DesktopEntry> {
    parse_desktop_entry_text(&fs::read_to_string(path).ok()?, path, preferred_language)
}

fn parse_desktop_entry_text(
    text: &str,
    path: &Path,
    preferred_language: Option<&str>,
) -> Option<DesktopEntry> {
    let language = preferred_language
        .and_then(|language| language.split(['-', '_']).next())
        .unwrap_or("");
    let mut in_entry = false;
    let mut name = None;
    let mut localized_name = None;
    let mut no_display = false;
    let mut flatpak_id = None;
    let mut snap_id = None;
    let mut icon_path = None;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "Name" => name = Some(value.trim().to_owned()),
            key if !language.is_empty() && key == format!("Name[{language}]") => {
                localized_name = Some(value.trim().to_owned())
            }
            "NoDisplay" => no_display = value.eq_ignore_ascii_case("true"),
            "X-Flatpak" => flatpak_id = Some(value.trim().to_owned()),
            "X-SnapInstanceName" => snap_id = Some(value.trim().to_owned()),
            "Icon" if value.starts_with('/') => icon_path = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    if snap_id.is_none() && path.starts_with("/var/lib/snapd/desktop/applications") {
        snap_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.split('_').next())
            .map(str::to_owned);
    }
    Some(DesktopEntry {
        name: localized_name.or(name)?,
        no_display,
        flatpak_id,
        snap_id,
        icon_path,
    })
}

#[cfg(target_os = "linux")]
fn deb_desktop_owners() -> HashMap<PathBuf, String> {
    let output = bounded_command::output(
        Command::new("dpkg-query").args(["-S", "/usr/share/applications/*.desktop"]),
        INVENTORY_COMMAND_TIMEOUT,
        INVENTORY_COMMAND_OUTPUT_LIMIT,
    );
    let Ok(output) = output else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (package, path) = line.split_once(": ")?;
            let package = package.split(',').next()?.trim();
            Some((PathBuf::from(path.trim()), package.to_owned()))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn rpm_desktop_owners(paths: &[PathBuf]) -> HashMap<PathBuf, String> {
    let mut owners = HashMap::new();
    for chunk in paths.chunks(128) {
        let mut command = Command::new("rpm");
        command.args(["-qf", "--qf", "[%{NAME}\\t%{FILENAMES}\\n]", "--"]);
        command.args(chunk);
        let Ok(output) = bounded_command::output(
            &mut command,
            INVENTORY_COMMAND_TIMEOUT,
            INVENTORY_COMMAND_OUTPUT_LIMIT,
        ) else {
            continue;
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Some((package, path)) = line.split_once('\t') else {
                continue;
            };
            if path.ends_with(".desktop") && !package.trim().is_empty() {
                owners.insert(PathBuf::from(path.trim()), package.trim().to_owned());
            }
        }
    }
    owners
}

#[cfg(target_os = "linux")]
fn execute_fixed_native_uninstaller(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<ExitStatus, CommandError> {
    validate_native_identifier(source, identifier)?;
    let status = match source {
        ApplicationInstallationSource::LinuxFlatpak => {
            let (scope, package) = identifier.split_once(':').ok_or_else(|| {
                CommandError::new(
                    "application_identity_invalid",
                    "The Flatpak identity did not include an installation scope.",
                )
            })?;
            let mut command = Command::new("flatpak");
            command.arg("uninstall");
            command.arg(if scope == "user" {
                "--user"
            } else {
                "--system"
            });
            command.args(["--noninteractive", "--", package]).status()
        }
        ApplicationInstallationSource::LinuxDeb => Command::new("pkexec")
            .args(["apt-get", "remove", "--yes", "--", identifier])
            .status(),
        ApplicationInstallationSource::LinuxRpm => Command::new("pkexec")
            .args(["dnf", "remove", "-y", "--", identifier])
            .status(),
        ApplicationInstallationSource::LinuxSnap => Command::new("pkexec")
            .args(["snap", "remove", "--", identifier])
            .status(),
        _ => {
            return Err(CommandError::new(
                "native_uninstall_method_unavailable",
                "This Linux install source is not supported.",
            ));
        }
    };
    status.map_err(|error| {
        CommandError::internal(format!(
            "Could not start the Linux package manager: {error}"
        ))
    })
}

#[cfg(not(any(windows, target_os = "linux")))]
fn execute_fixed_native_uninstaller(
    source: ApplicationInstallationSource,
    identifier: &str,
) -> Result<ExitStatus, CommandError> {
    let _ = (source, identifier);
    Err(CommandError::new(
        "native_uninstall_method_unavailable",
        "Native package uninstall is unavailable on this platform.",
    ))
}

fn native_application(
    name: String,
    source: ApplicationInstallationSource,
    identifier: String,
    size_bytes: u64,
    icon_path: Option<String>,
    protected: bool,
    requires_elevation: bool,
) -> InstalledApplication {
    InstalledApplication {
        name,
        path: format!("native://{}/{}", native_source_slug(source), identifier,),
        bundle_id: None,
        size_bytes,
        last_used_at_ms: None,
        modified_at_ms: None,
        uninstallable: !protected,
        unavailable_reason: protected.then(|| "protected_application".to_owned()),
        installation_source: source,
        native_uninstall_identifier: Some(identifier),
        native_uninstall_requires_elevation: requires_elevation,
        icon_path,
    }
}

fn native_source_slug(source: ApplicationInstallationSource) -> &'static str {
    match source {
        ApplicationInstallationSource::WindowsMsi => "windows-msi",
        ApplicationInstallationSource::WindowsMsix => "windows-msix",
        ApplicationInstallationSource::WindowsUninstaller => "windows-uninstaller",
        ApplicationInstallationSource::LinuxFlatpak => "linux-flatpak",
        ApplicationInstallationSource::LinuxDeb => "linux-deb",
        ApplicationInstallationSource::LinuxRpm => "linux-rpm",
        ApplicationInstallationSource::LinuxSnap => "linux-snap",
        ApplicationInstallationSource::Portable => "portable",
        _ => "unknown",
    }
}

fn native_inventory(applications: Vec<InstalledApplication>) -> ApplicationInventorySnapshot {
    ApplicationInventorySnapshot {
        sampled_at_ms: now_millis(),
        platform_supported: true,
        cached: false,
        refresh_recommended: false,
        applications,
    }
}

fn sort_native_applications(applications: &mut [InstalledApplication]) {
    applications.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
}

#[cfg(target_os = "linux")]
fn system_time_millis(value: std::time::SystemTime) -> Option<u64> {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use super::{
        PLAN_TTL_MS, StoredPlan, outcome_from_exit, parse_desktop_entry_text,
        parse_windows_inventory, take_plan, validate_native_identifier,
    };
    use crate::models::{ApplicationInstallationSource, NativeApplicationUninstallOutcome};

    #[test]
    fn accepts_package_manager_ids_and_rejects_shell_data() {
        assert!(
            validate_native_identifier(
                ApplicationInstallationSource::LinuxFlatpak,
                "user:com.example.Editor",
            )
            .is_ok(),
        );
        assert!(
            validate_native_identifier(
                ApplicationInstallationSource::LinuxDeb,
                "example-editor:amd64",
            )
            .is_ok(),
        );
        assert!(
            validate_native_identifier(
                ApplicationInstallationSource::LinuxDeb,
                "example; rm -rf /",
            )
            .is_err(),
        );
    }

    #[test]
    fn validates_windows_product_codes() {
        assert!(
            validate_native_identifier(
                ApplicationInstallationSource::WindowsMsi,
                "{12345678-1234-1234-1234-1234567890AB}",
            )
            .is_ok(),
        );
    }

    #[test]
    fn parses_windows_catalog_fixtures_and_rejects_untrusted_sources() {
        let applications = parse_windows_inventory(
            br#"[
              {"name":"Editor","id":"{12345678-1234-1234-1234-1234567890AB}","source":"windows_msi","size":4096,"icon":"C:\\Editor.exe"},
              {"name":"Store App","id":"Contoso.App_1.0_x64__abc","source":"windows_msix","size":0,"icon":null},
              {"name":"Ignored","id":"cmd.exe /c bad","source":"windows_uninstaller","size":0}
            ]"#,
        );

        assert_eq!(applications.len(), 2);
        assert_eq!(
            applications[0].installation_source,
            ApplicationInstallationSource::WindowsMsi,
        );
        assert_eq!(applications[0].size_bytes, 4096);
        assert!(applications[1].uninstallable);
    }

    #[test]
    fn parses_localized_desktop_entry_fixtures() {
        let entry = parse_desktop_entry_text(
            "[Desktop Entry]\nName=Editor\nName[zh]=编辑器\nX-Flatpak=com.example.Editor\nIcon=/tmp/editor.png\n",
            Path::new("/usr/share/applications/editor.desktop"),
            Some("zh-CN"),
        )
        .unwrap();

        assert_eq!(entry.name, "编辑器");
        assert_eq!(entry.flatpak_id.as_deref(), Some("com.example.Editor"));
        assert_eq!(entry.icon_path.as_deref(), Some("/tmp/editor.png"));
    }

    #[test]
    fn maps_native_exit_codes_without_platform_processes() {
        assert_eq!(
            outcome_from_exit(true, Some(0)),
            NativeApplicationUninstallOutcome::Succeeded,
        );
        assert_eq!(
            outcome_from_exit(false, Some(1602)),
            NativeApplicationUninstallOutcome::Cancelled,
        );
        assert_eq!(
            outcome_from_exit(false, Some(3010)),
            NativeApplicationUninstallOutcome::RestartRequired,
        );
        assert_eq!(
            outcome_from_exit(false, Some(1)),
            NativeApplicationUninstallOutcome::Failed,
        );
    }

    #[test]
    fn uninstall_plans_are_short_lived_and_single_use() {
        let plan = StoredPlan {
            created_at_ms: 100,
            source: ApplicationInstallationSource::LinuxDeb,
            identifier: "editor".to_owned(),
        };
        let mut plans = HashMap::from([("valid".to_owned(), plan.clone())]);
        assert!(take_plan(&mut plans, "valid", 101).is_ok());
        assert!(take_plan(&mut plans, "valid", 102).is_err());

        plans.insert("expired".to_owned(), plan);
        assert!(take_plan(&mut plans, "expired", 100 + PLAN_TTL_MS + 1).is_err(),);
        assert!(!plans.contains_key("expired"));
    }
}
