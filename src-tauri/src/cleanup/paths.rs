use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::env;

use crate::models::{CleanupLocationKind, CleanupSafety};

#[derive(Clone, Debug)]
pub(super) struct LocationDefinition {
    pub(super) kind: CleanupLocationKind,
    pub(super) paths: Vec<PathBuf>,
    pub(super) safety: CleanupSafety,
}

pub(super) fn platform_paths(home: &Path) -> Vec<LocationDefinition> {
    vec![
        LocationDefinition {
            kind: CleanupLocationKind::Downloads,
            paths: vec![home.join("Downloads")],
            safety: CleanupSafety::Review,
        },
        LocationDefinition {
            kind: CleanupLocationKind::Trash,
            paths: trash_paths(home),
            safety: CleanupSafety::Reclaimable,
        },
        LocationDefinition {
            kind: CleanupLocationKind::AppCache,
            paths: app_cache_paths(home),
            safety: CleanupSafety::Reclaimable,
        },
        LocationDefinition {
            kind: CleanupLocationKind::DeveloperCache,
            paths: developer_cache_paths(home),
            safety: CleanupSafety::Reclaimable,
        },
        LocationDefinition {
            kind: CleanupLocationKind::HiddenData,
            paths: hidden_user_paths(home),
            safety: CleanupSafety::Review,
        },
    ]
}

#[cfg(target_os = "macos")]
pub(super) fn trash_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".Trash")]
}

#[cfg(target_os = "linux")]
pub(super) fn trash_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".local/share/Trash/files")]
}

#[cfg(windows)]
pub(super) fn trash_paths(_home: &Path) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn app_cache_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join("Library/Caches")]
}

#[cfg(target_os = "linux")]
fn app_cache_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".cache")]
}

#[cfg(windows)]
fn app_cache_paths(_home: &Path) -> Vec<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| vec![path.join("Temp")])
        .unwrap_or_default()
}

fn developer_cache_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        home.join(".cargo/registry"),
        home.join(".cargo/git"),
        home.join(".npm/_cacache"),
        home.join(".pnpm-store"),
        home.join(".yarn/berry/cache"),
        home.join(".gradle/caches"),
        home.join(".m2/repository"),
        home.join(".bun/install/cache"),
        home.join(".rustup/downloads"),
        home.join(".rustup/tmp"),
    ];
    #[cfg(not(target_os = "linux"))]
    paths.push(home.join(".cache"));
    #[cfg(target_os = "macos")]
    {
        paths.push(home.join("Library/Developer/Xcode/DerivedData"));
        paths.push(home.join("Library/pnpm/store"));
    }
    #[cfg(target_os = "linux")]
    {
        paths.push(home.join(".local/share/pnpm/store"));
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local_app_data).join("pnpm/store"));
        }
    }
    paths
}

pub(super) fn hidden_user_paths(home: &Path) -> Vec<PathBuf> {
    const CATEGORIZED_DIRECTORIES: &[&str] = &[
        ".Trash",
        ".bun",
        ".cache",
        ".cargo",
        ".gradle",
        ".local",
        ".m2",
        ".npm",
        ".pnpm-store",
        ".rustup",
        ".yarn",
    ];

    let Ok(entries) = fs::read_dir(home) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            if !name.starts_with('.') || CATEGORIZED_DIRECTORIES.contains(&name) {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            (file_type.is_dir() && !file_type.is_symlink()).then(|| entry.path())
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}
