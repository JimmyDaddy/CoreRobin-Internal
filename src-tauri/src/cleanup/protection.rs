use std::env;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use crate::file_ownership::{FileOwnership, ownership};
use crate::models::CleanupProtectionReason;

use super::paths::trash_paths;

#[derive(Clone, Debug)]
pub(super) struct CleanupDeleteBoundary {
    pub(super) aliases: Vec<PathBuf>,
    pub(super) canonical_root: PathBuf,
    pub(super) trusted_system_root: bool,
}

pub(super) fn cleanup_protection_for_path(
    path: &Path,
    home: &Path,
) -> Option<CleanupProtectionReason> {
    if path.starts_with(home) {
        let relative = path.strip_prefix(home).ok()?;
        if relative.as_os_str().is_empty() {
            return Some(CleanupProtectionReason::HomeRoot);
        }

        let trash_roots = trash_paths(home);
        if trash_roots.iter().any(|trash_root| path == trash_root) {
            return Some(CleanupProtectionReason::TrashRoot);
        }
        if trash_roots
            .iter()
            .any(|trash_root| path.starts_with(trash_root))
        {
            return None;
        }

        return is_sensitive_cleanup_relative_path(relative)
            .then_some(CleanupProtectionReason::SensitiveUserData);
    }

    let Some((boundary, relative)) = temporary_cleanup_boundary_for_path(path) else {
        return Some(CleanupProtectionReason::SystemLocation);
    };
    if relative.as_os_str().is_empty() {
        return Some(CleanupProtectionReason::SystemLocation);
    }
    let canonical_path = boundary.canonical_root.join(relative);
    match ownership(&canonical_path) {
        FileOwnership::CurrentUser => None,
        FileOwnership::OtherUser | FileOwnership::Unavailable => {
            Some(CleanupProtectionReason::SystemLocation)
        }
    }
}

fn is_sensitive_cleanup_relative_path(relative: &Path) -> bool {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let Some(value) = value.to_str() else {
                    return true;
                };
                parts.push(value);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return true,
        }
    }
    let Some(first) = parts.first() else {
        return true;
    };

    // Hidden names are an interface convention, not a security boundary.
    // Protect only credential stores and app-managed personal libraries whose
    // raw recursive removal would bypass the owning application's semantics.
    const PROTECTED_USER_SUBTREES: &[&[&str]] = &[
        &[".ssh"],
        &[".gnupg"],
        &[".aws"],
        &[".azure"],
        &[".kube"],
        &[".password-store"],
        &[".config", "gcloud"],
        &[".config", "gh"],
        &[".config", "rclone"],
        &[".local", "share", "keyrings"],
        &["Library", "Accounts"],
        &["Library", "Calendars"],
        &["Library", "CloudStorage"],
        &["Library", "HomeKit"],
        &["Library", "IdentityServices"],
        &["Library", "Keychains"],
        &["Library", "Mail"],
        &["Library", "Messages"],
        &["Library", "Mobile Documents"],
        &["Library", "PersonalizationPortrait"],
        &["Library", "Safari"],
        &["Library", "Application Support", "AddressBook"],
        &["Library", "Application Support", "CallHistoryDB"],
        &["Library", "Application Support", "CallHistoryTransactions"],
        &["Library", "Application Support", "Knowledge"],
        &["Library", "Application Support", "MobileSync"],
        &["Library", "Application Support", "com.apple.TCC"],
        &["Library", "Containers", "com.apple.Home"],
        &["Library", "Containers", "com.apple.MobileSMS"],
        &["Library", "Containers", "com.apple.Safari"],
        &["Library", "Containers", "com.apple.mail"],
        &["Library", "Group Containers", "group.com.apple.mail"],
        &["AppData", "Roaming", "Microsoft", "Credentials"],
        &["AppData", "Roaming", "Microsoft", "Crypto"],
        &["AppData", "Roaming", "Microsoft", "Protect"],
        &["AppData", "Roaming", "Microsoft", "Vault"],
    ];
    if PROTECTED_USER_SUBTREES
        .iter()
        .any(|prefix| cleanup_components_start_with(&parts, prefix))
    {
        return true;
    }

    const PROTECTED_PROFILE_FILES: &[&str] = &[
        ".git-credentials",
        ".netrc",
        ".npmrc",
        ".pypirc",
        "NTUSER.DAT",
        "NTUSER.DAT.LOG1",
        "NTUSER.DAT.LOG2",
        "ntuser.ini",
    ];
    if parts.len() == 1
        && PROTECTED_PROFILE_FILES
            .iter()
            .any(|candidate| cleanup_component_matches(first, candidate))
    {
        return true;
    }

    if parts.iter().any(|part| {
        let lower = part.to_ascii_lowercase();
        lower.ends_with(".photoslibrary") || lower.ends_with(".photolibrary")
    }) {
        return true;
    }

    if cleanup_component_matches(first, "System") {
        return true;
    }

    // Keep broad profile/category roots view-only, while allowing the user to
    // drill down to a concrete app-owned child. Cache and log roots remain
    // directly actionable because they are explicitly regeneratable.
    if cleanup_component_matches(first, "Library") && parts.len() <= 2 {
        return parts.len() == 1
            || !["Caches", "Logs"]
                .iter()
                .any(|candidate| cleanup_component_matches(parts[1], candidate));
    }
    if cleanup_component_matches(first, "AppData") && parts.len() <= 2 {
        return true;
    }
    parts.len() == 1
        && ["Applications"]
            .iter()
            .any(|candidate| cleanup_component_matches(first, candidate))
}

pub(super) fn cleanup_protection_for_selected_scan_path(
    path: &Path,
    home: &Path,
    scan_root: &Path,
) -> Option<CleanupProtectionReason> {
    if path == scan_root || !path.starts_with(scan_root) {
        return Some(CleanupProtectionReason::SystemLocation);
    }
    if path.starts_with(home) || temporary_cleanup_boundary_for_path(path).is_some() {
        return cleanup_protection_for_path(path, home);
    }
    if is_system_managed_cleanup_path(path) {
        return Some(CleanupProtectionReason::SystemLocation);
    }
    match ownership(path) {
        FileOwnership::CurrentUser => None,
        FileOwnership::OtherUser => Some(CleanupProtectionReason::SystemLocation),
        #[cfg(windows)]
        FileOwnership::Unavailable => None,
        #[cfg(not(windows))]
        FileOwnership::Unavailable => Some(CleanupProtectionReason::SystemLocation),
    }
}

#[cfg(target_os = "macos")]
fn is_system_managed_cleanup_path(path: &Path) -> bool {
    if path.starts_with("/usr/local") {
        return false;
    }
    ["/System", "/usr", "/bin", "/sbin", "/var", "/private/var"]
        .iter()
        .any(|root| path.starts_with(root))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn is_system_managed_cleanup_path(path: &Path) -> bool {
    if path.starts_with("/usr/local") {
        return false;
    }
    [
        "/boot", "/dev", "/etc", "/proc", "/run", "/sys", "/usr", "/var", "/bin", "/sbin", "/lib",
        "/lib64",
    ]
    .iter()
    .any(|root| path.starts_with(root))
}

#[cfg(windows)]
fn is_system_managed_cleanup_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    [
        "SystemRoot",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "ALLUSERSPROFILE",
    ]
    .iter()
    .filter_map(env::var_os)
    .map(PathBuf::from)
    .map(|root| root.to_string_lossy().replace('\\', "/").to_lowercase())
    .any(|root| normalized == root || normalized.starts_with(&format!("{root}/")))
}

#[cfg(not(any(unix, windows)))]
fn is_system_managed_cleanup_path(_path: &Path) -> bool {
    false
}

fn temporary_cleanup_boundaries() -> &'static [CleanupDeleteBoundary] {
    static BOUNDARIES: OnceLock<Vec<CleanupDeleteBoundary>> = OnceLock::new();
    BOUNDARIES.get_or_init(|| {
        let mut boundaries = Vec::new();
        #[cfg(unix)]
        for root in [PathBuf::from("/tmp"), PathBuf::from("/var/tmp")] {
            add_temporary_cleanup_boundary(&mut boundaries, root, true);
        }
        add_temporary_cleanup_boundary(&mut boundaries, env::temp_dir(), false);
        #[cfg(target_os = "macos")]
        if let Some(cache) = darwin_user_directory(libc::_CS_DARWIN_USER_CACHE_DIR) {
            add_temporary_cleanup_boundary(&mut boundaries, cache, false);
        }
        boundaries
    })
}

fn add_temporary_cleanup_boundary(
    boundaries: &mut Vec<CleanupDeleteBoundary>,
    alias: PathBuf,
    trusted_system_root: bool,
) {
    let Ok(canonical_root) = alias.canonicalize() else {
        return;
    };
    if let Some(existing) = boundaries
        .iter_mut()
        .find(|boundary| boundary.canonical_root == canonical_root)
    {
        if !existing.aliases.contains(&alias) {
            existing.aliases.push(alias);
        }
        existing.trusted_system_root |= trusted_system_root;
        return;
    }
    let mut aliases = vec![alias];
    if !aliases.contains(&canonical_root) {
        aliases.push(canonical_root.clone());
    }
    boundaries.push(CleanupDeleteBoundary {
        aliases,
        canonical_root,
        trusted_system_root,
    });
}

pub(super) fn temporary_cleanup_boundary_for_path(
    path: &Path,
) -> Option<(&'static CleanupDeleteBoundary, PathBuf)> {
    temporary_cleanup_boundaries()
        .iter()
        .flat_map(|boundary| {
            boundary.aliases.iter().filter_map(move |alias| {
                path.strip_prefix(alias)
                    .ok()
                    .map(|relative| (alias.components().count(), boundary, relative.to_path_buf()))
            })
        })
        .max_by_key(|(depth, _, _)| *depth)
        .map(|(_, boundary, relative)| (boundary, relative))
}

#[cfg(target_os = "macos")]
fn darwin_user_directory(name: libc::c_int) -> Option<PathBuf> {
    let length = unsafe { libc::confstr(name, std::ptr::null_mut(), 0) };
    if length <= 1 {
        return None;
    }
    let mut buffer = vec![0_i8; length];
    let written = unsafe { libc::confstr(name, buffer.as_mut_ptr(), buffer.len()) };
    if written == 0 {
        return None;
    }
    let value = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) };
    Some(PathBuf::from(value.to_string_lossy().as_ref()))
}

fn cleanup_components_start_with(parts: &[&str], prefix: &[&str]) -> bool {
    parts.len() >= prefix.len()
        && parts
            .iter()
            .zip(prefix)
            .all(|(part, candidate)| cleanup_component_matches(part, candidate))
}

fn cleanup_component_matches(value: &str, candidate: &str) -> bool {
    if cfg!(windows) {
        value.eq_ignore_ascii_case(candidate)
    } else {
        value == candidate
    }
}
