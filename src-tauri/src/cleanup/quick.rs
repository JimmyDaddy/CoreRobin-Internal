use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::CommandError;
use crate::models::{
    QuickCleanCategory, QuickCleanCategoryResult, QuickCleanCategorySummary,
    QuickCleanProgress, QuickCleanRequest, QuickCleanResult,
};
use crate::safe_fs::DeleteRoot;

use super::home_directory;

// Quick cleanup only touches regenerable or already-discarded user data in
// well-known, user-owned locations. Everything else (documents, app data,
// cookies, downloads) is deliberately out of scope.
const QUICK_CLEAN_ANALYZE_ENTRY_CAP: usize = 250_000;
// Emit a progress update at least this often while deleting one entry, so a
// multi-gigabyte cache with hundreds of thousands of files keeps the UI
// moving instead of looking frozen until the entry finishes.
const QUICK_CLEAN_PROGRESS_INTERVAL: usize = 256;
const QUICK_CLEAN_ORDER: [QuickCleanCategory; 4] = [
    QuickCleanCategory::UserCache,
    QuickCleanCategory::Logs,
    QuickCleanCategory::TempFiles,
    QuickCleanCategory::Trash,
];

#[derive(Debug, Default)]
pub struct QuickCleanCoordinator {
    active: Mutex<Option<Arc<AtomicBool>>>,
}

impl QuickCleanCoordinator {
    pub fn begin(&self) -> Result<Arc<AtomicBool>, CommandError> {
        let mut active = self.active.lock().map_err(|_| {
            CommandError::internal("The quick cleanup coordinator lock was poisoned.")
        })?;
        if active.is_some() {
            return Err(CommandError::new(
                "quick_clean_in_progress",
                "A quick cleanup is already in progress.",
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancelled));
        Ok(cancelled)
    }

    pub fn cancel(&self) -> Result<bool, CommandError> {
        let active = self.active.lock().map_err(|_| {
            CommandError::internal("The quick cleanup coordinator lock was poisoned.")
        })?;
        let Some(cancelled) = active.as_ref() else {
            return Ok(false);
        };
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    }

    pub fn finish(&self, cancelled: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active.lock()
            && active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, cancelled))
        {
            *active = None;
        }
    }
}

#[derive(Clone, Debug)]
struct QuickCleanRoots {
    home: PathBuf,
    temp: PathBuf,
}

impl QuickCleanRoots {
    fn resolve() -> Result<Self, CommandError> {
        let home = home_directory().ok_or_else(|| {
            CommandError::internal("Could not resolve the user home directory for quick cleanup.")
        })?;
        Ok(Self {
            home,
            temp: std::env::temp_dir(),
        })
    }
}

pub(crate) fn analyze_quick_cleanup() -> Result<Vec<QuickCleanCategorySummary>, CommandError> {
    let roots = QuickCleanRoots::resolve()?;
    Ok(analyze_quick_cleanup_at(&roots))
}

fn analyze_quick_cleanup_at(roots: &QuickCleanRoots) -> Vec<QuickCleanCategorySummary> {
    QUICK_CLEAN_ORDER
        .into_iter()
        .map(|category| analyze_category(category, category_root(category, roots)))
        .collect()
}

fn category_root(category: QuickCleanCategory, roots: &QuickCleanRoots) -> PathBuf {
    match category {
        QuickCleanCategory::UserCache => roots.home.join("Library/Caches"),
        QuickCleanCategory::Logs => roots.home.join("Library/Logs"),
        QuickCleanCategory::TempFiles => roots.temp.clone(),
        QuickCleanCategory::Trash => roots.home.join(".Trash"),
    }
}

fn analyze_category(category: QuickCleanCategory, root: PathBuf) -> QuickCleanCategorySummary {
    let mut summary = QuickCleanCategorySummary {
        category,
        byte_size: 0,
        item_count: 0,
        skipped_count: 0,
        available: false,
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return summary;
    };
    summary.available = true;
    let mut pending = Vec::new();
    let mut budget = QUICK_CLEAN_ANALYZE_ENTRY_CAP;
    for entry in entries.flatten() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        let path = entry.path();
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {
                summary.item_count = summary.item_count.saturating_add(1);
                if metadata.is_dir() {
                    pending.push(path);
                } else if metadata.is_file() {
                    summary.byte_size = summary.byte_size.saturating_add(allocated_size(&metadata));
                }
            }
            _ => {
                summary.skipped_count = summary.skipped_count.saturating_add(1);
            }
        }
    }
    while let Some(directory) = pending.pop() {
        if budget == 0 {
            break;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let path = entry.path();
            match fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.file_type().is_symlink() => {
                    summary.item_count = summary.item_count.saturating_add(1);
                    if metadata.is_dir() {
                        pending.push(path);
                    } else if metadata.is_file() {
                        summary.byte_size =
                            summary.byte_size.saturating_add(allocated_size(&metadata));
                    }
                }
                _ => {
                    summary.skipped_count = summary.skipped_count.saturating_add(1);
                }
            }
        }
    }
    summary
}

pub(crate) fn run_quick_cleanup(
    request: &QuickCleanRequest,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(QuickCleanProgress),
) -> Result<QuickCleanResult, CommandError> {
    let roots = QuickCleanRoots::resolve()?;
    run_quick_cleanup_at(roots, request, cancelled, on_progress)
}

fn run_quick_cleanup_at(
    roots: QuickCleanRoots,
    request: &QuickCleanRequest,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(QuickCleanProgress),
) -> Result<QuickCleanResult, CommandError> {
    let mut result = QuickCleanResult {
        freed_bytes: 0,
        freed_items: 0,
        skipped_items: 0,
        results: Vec::new(),
    };
    for category in &request.categories {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let category_result = clean_category(
            *category,
            &category_root(*category, &roots),
            cancelled,
            on_progress,
        )?;
        result.freed_bytes = result.freed_bytes.saturating_add(category_result.freed_bytes);
        result.freed_items = result.freed_items.saturating_add(category_result.freed_items);
        result.skipped_items = result.skipped_items.saturating_add(category_result.skipped_items);
        result.results.push(category_result);
    }
    Ok(result)
}

fn clean_category(
    category: QuickCleanCategory,
    root: &Path,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(QuickCleanProgress),
) -> Result<QuickCleanCategoryResult, CommandError> {
    let mut out = QuickCleanCategoryResult {
        category,
        freed_bytes: 0,
        freed_items: 0,
        skipped_items: 0,
    };
    let delete_root = match DeleteRoot::open(root) {
        Ok(root) => root,
        // Missing or inaccessible roots simply have nothing to clean.
        Err(_) => return Ok(out),
    };
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(out);
    };
    let mut names = entries
        .flatten()
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
    names.sort();
    let total_item_count = names.len();
    let mut processed_item_count = 0;
    for name in names {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        processed_item_count += 1;
        let current_path = name.to_string_lossy().into_owned();
        let bound = match delete_root.bind(Path::new(&name)) {
            Ok(bound) => bound,
            // Symbolic links and special entries are never deleted.
            Err(_) => {
                out.skipped_items += 1;
                emit_progress(
                    on_progress,
                    category,
                    processed_item_count,
                    total_item_count,
                    out.freed_bytes,
                    out.freed_items,
                    out.skipped_items,
                    &current_path,
                );
                continue;
            }
        };
        let mut entry_bytes = 0_u64;
        let mut entry_files = 0_u64;
        let mut throttled_files = 0_u64;
        // Cache trees legitimately contain internal symlinks (e.g.
        // node_modules/.bin, app bundle links). They are unlinked as entries,
        // never followed, so the whole cache entry can be removed.
        match bound.delete_cancellable_allowing_internal_symlinks(cancelled, &mut |bytes| {
            entry_bytes = entry_bytes.saturating_add(bytes);
            entry_files = entry_files.saturating_add(1);
            if entry_files.saturating_sub(throttled_files) >= QUICK_CLEAN_PROGRESS_INTERVAL as u64 {
                throttled_files = entry_files;
                emit_progress(
                    on_progress,
                    category,
                    processed_item_count,
                    total_item_count,
                    out.freed_bytes.saturating_add(entry_bytes),
                    out.freed_items.saturating_add(entry_files),
                    out.skipped_items,
                    &current_path,
                );
            }
        }) {
            Ok(true) => {
                out.freed_items = out.freed_items.saturating_add(entry_files);
                out.freed_bytes = out.freed_bytes.saturating_add(entry_bytes);
            }
            Ok(false) | Err(_) => {
                // Cancelled partway or an entry that could not be removed
                // (in use, permission, changed while binding).
                out.skipped_items += 1;
            }
        }
        emit_progress(
            on_progress,
            category,
            processed_item_count,
            total_item_count,
            out.freed_bytes,
            out.freed_items,
            out.skipped_items,
            &current_path,
        );
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    on_progress: &mut dyn FnMut(QuickCleanProgress),
    category: QuickCleanCategory,
    processed_item_count: usize,
    total_item_count: usize,
    freed_bytes: u64,
    freed_items: u64,
    skipped_items: u64,
    current_path: &str,
) {
    on_progress(QuickCleanProgress {
        category,
        processed_item_count,
        total_item_count,
        freed_bytes,
        freed_items,
        skipped_items,
        current_path: current_path.to_owned(),
    });
}

#[cfg(unix)]
fn allocated_size(metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks().saturating_mul(512)
}

#[cfg(windows)]
fn allocated_size(metadata: &fs::Metadata) -> u64 {
    metadata.len()
}

#[cfg(not(any(unix, windows)))]
fn allocated_size(metadata: &fs::Metadata) -> u64 {
    metadata.len()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;

    use tempfile::tempdir;

    use super::*;
    use crate::models::{QuickCleanCategory, QuickCleanRequest};

    fn fixture_roots(base: &Path) -> QuickCleanRoots {
        QuickCleanRoots {
            home: base.join("home"),
            temp: base.join("temp"),
        }
    }

    fn write_file(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![1_u8; bytes]).unwrap();
    }

    fn seed_fixture(base: &Path) -> QuickCleanRoots {
        let roots = fixture_roots(base);
        write_file(&roots.home.join("Library/Caches/com.example/cache.bin"), 2_048);
        write_file(&roots.home.join("Library/Caches/com.example/deep/nested.bin"), 4_096);
        write_file(&roots.home.join("Library/Logs/example.log"), 1_024);
        write_file(&roots.home.join(".Trash/old.bin"), 512);
        write_file(&roots.temp.join("tmp0.tmp"), 256);
        roots
    }

    #[test]
    fn analysis_reports_fixture_sizes_per_category() {
        let fixture = tempdir().unwrap();
        let roots = seed_fixture(fixture.path());
        let summaries = analyze_quick_cleanup_at(&roots);
        let by_category = |category| {
            summaries
                .iter()
                .find(|summary| summary.category == category)
                .unwrap()
        };
        let caches = by_category(QuickCleanCategory::UserCache);
        assert!(caches.available);
        assert_eq!(caches.item_count, 4);
        assert!(caches.byte_size >= 6_144);
        let logs = by_category(QuickCleanCategory::Logs);
        assert_eq!(logs.item_count, 1);
        assert!(logs.byte_size >= 1_024);
        let trash = by_category(QuickCleanCategory::Trash);
        assert_eq!(trash.item_count, 1);
        assert!(trash.byte_size >= 512);
        let temp = by_category(QuickCleanCategory::TempFiles);
        assert_eq!(temp.item_count, 1);
        assert!(temp.byte_size >= 256);
    }

    #[test]
    fn cleaning_removes_selected_category_contents_but_keeps_roots() {
        let fixture = tempdir().unwrap();
        let roots = seed_fixture(fixture.path());
        let cancelled = AtomicBool::new(false);
        let mut progress = Vec::new();
        let result = run_quick_cleanup_at(
            roots.clone(),
            &QuickCleanRequest {
                categories: vec![QuickCleanCategory::UserCache, QuickCleanCategory::Trash],
            },
            &cancelled,
            &mut |update| progress.push(update),
        )
        .unwrap();

        assert_eq!(result.results.len(), 2);
        let caches = result
            .results
            .iter()
            .find(|result| result.category == QuickCleanCategory::UserCache)
            .unwrap();
        assert_eq!(caches.freed_items, 4);
        assert!(caches.freed_bytes >= 6_144);
        assert!(roots.home.join("Library/Caches").is_dir());
        assert!(!roots.home.join("Library/Caches/com.example").exists());
        assert!(roots.home.join("Library/Logs/example.log").exists());
        let trash = result
            .results
            .iter()
            .find(|result| result.category == QuickCleanCategory::Trash)
            .unwrap();
        assert_eq!(trash.freed_items, 1);
        assert!(roots.home.join(".Trash").is_dir());
        assert!(!roots.home.join(".Trash/old.bin").exists());
        assert!(roots.temp.join("tmp0.tmp").exists());
        assert!(progress.len() >= 2);
    }

    #[test]
    fn internal_symlinks_are_unlinked_without_following() {
        let fixture = tempdir().unwrap();
        let roots = fixture_roots(fixture.path());
        let target = fixture.path().join("outside.bin");
        write_file(&target, 8_192);
        let pkg = roots.home.join("Library/Caches/Yarn/v6/npm-pkg/node_modules/pkg/.bin");
        write_file(&roots.home.join("Library/Caches/Yarn/v6/npm-pkg/node_modules/pkg/index.js"), 512);
        fs::create_dir_all(&pkg).unwrap();
        symlink("../../pkg/index.js", pkg.join("pkg")).unwrap();

        let cancelled = AtomicBool::new(false);
        let result = run_quick_cleanup_at(
            roots.clone(),
            &QuickCleanRequest {
                categories: vec![QuickCleanCategory::UserCache],
            },
            &cancelled,
            &mut |_| {},
        )
        .unwrap();
        let caches = result
            .results
            .iter()
            .find(|result| result.category == QuickCleanCategory::UserCache)
            .unwrap();
        assert_eq!(caches.freed_items, 8);
        assert_eq!(caches.skipped_items, 0);
        assert!(!roots.home.join("Library/Caches/Yarn").exists());
        assert!(target.exists());
    }

    #[test]
    fn large_entries_emit_throttled_progress_while_deleting() {
        let fixture = tempdir().unwrap();
        let roots = fixture_roots(fixture.path());
        let big = roots.home.join("Library/Caches/big-cache");
        for index in 0..600 {
            write_file(&big.join(format!("file-{index:04}.bin")), 256);
        }
        let cancelled = AtomicBool::new(false);
        let mut progress = Vec::new();
        let result = run_quick_cleanup_at(
            roots.clone(),
            &QuickCleanRequest {
                categories: vec![QuickCleanCategory::UserCache],
            },
            &cancelled,
            &mut |update| progress.push(update),
        )
        .unwrap();
        assert!(
            progress.len() >= 3,
            "expected throttled progress events, got {}",
            progress.len()
        );
        let caches = result
            .results
            .iter()
            .find(|result| result.category == QuickCleanCategory::UserCache)
            .unwrap();
        assert!(caches.freed_items >= 600);
        assert!(!roots.home.join("Library/Caches/big-cache").exists());
    }

    #[test]
    fn symlinks_are_never_followed_or_deleted() {
        let fixture = tempdir().unwrap();
        let roots = fixture_roots(fixture.path());
        let target = fixture.path().join("outside.bin");
        write_file(&target, 8_192);
        write_file(&roots.home.join("Library/Caches/com.example/cache.bin"), 2_048);
        fs::create_dir_all(roots.home.join("Library/Caches")).unwrap();
        symlink(&target, roots.home.join("Library/Caches/link.bin")).unwrap();

        let summaries = analyze_quick_cleanup_at(&roots);
        let caches = summaries
            .iter()
            .find(|summary| summary.category == QuickCleanCategory::UserCache)
            .unwrap();
        assert_eq!(caches.skipped_count, 1);
        assert_eq!(caches.item_count, 2);

        let cancelled = AtomicBool::new(false);
        run_quick_cleanup_at(
            roots.clone(),
            &QuickCleanRequest {
                categories: vec![QuickCleanCategory::UserCache],
            },
            &cancelled,
            &mut |_| {},
        )
        .unwrap();
        assert!(target.exists());
        assert!(roots.home.join("Library/Caches/link.bin").exists());
    }

    #[test]
    fn missing_roots_are_reported_unavailable_and_clean_to_zero() {
        let fixture = tempdir().unwrap();
        let roots = fixture_roots(fixture.path());
        let summaries = analyze_quick_cleanup_at(&roots);
        for summary in &summaries {
            assert!(!summary.available);
            assert_eq!(summary.item_count, 0);
            assert_eq!(summary.byte_size, 0);
        }
        let cancelled = AtomicBool::new(false);
        let result = run_quick_cleanup_at(
            roots,
            &QuickCleanRequest {
                categories: QUICK_CLEAN_ORDER.to_vec(),
            },
            &cancelled,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.freed_items, 0);
        assert_eq!(result.results.len(), 4);
    }

    #[test]
    fn cancellation_stops_cleaning_before_touching_disk() {
        let fixture = tempdir().unwrap();
        let roots = seed_fixture(fixture.path());
        let cancelled = AtomicBool::new(true);
        let result = run_quick_cleanup_at(
            roots.clone(),
            &QuickCleanRequest {
                categories: QUICK_CLEAN_ORDER.to_vec(),
            },
            &cancelled,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.freed_items, 0);
        assert!(roots.home.join("Library/Caches/com.example/cache.bin").exists());
        assert!(roots.home.join(".Trash/old.bin").exists());
    }

    #[test]
    fn coordinator_rejects_concurrent_runs_and_cancels() {
        let coordinator = QuickCleanCoordinator::default();
        let first = coordinator.begin().unwrap();
        assert!(coordinator.begin().is_err());
        assert!(coordinator.cancel().unwrap());
        assert!(first.load(Ordering::Relaxed));
        coordinator.finish(&first);
        assert!(coordinator.begin().is_ok());
    }
}

#[cfg(test)]
mod bench {
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    use tempfile::tempdir;

    use super::run_quick_cleanup_at;
    use crate::cleanup::quick::{QuickCleanRoots, QUICK_CLEAN_ORDER};
    use crate::models::QuickCleanRequest;

    #[test]
    fn bench_delete_throughput() {
        let fixture = tempdir().unwrap();
        let mut roots = QuickCleanRoots {
            home: fixture.path().join("home"),
            temp: fixture.path().join("temp"),
        };
        if let Ok(external) = std::env::var("CORE_ROBIN_BENCH_HOME") {
            roots.home = external.into();
        }
        // Mimic the Yarn cache shape: 125 packages x 80 small files in nested dirs.
        for pkg in 0..125 {
            let dir = roots
                .home
                .join("Library/Caches/Yarn/v6")
                .join(format!("npm-pkg-{pkg}"));
            fs::create_dir_all(dir.join("node_modules/pkg/dist")).unwrap();
            for f in 0..80 {
                fs::write(
                    dir.join("node_modules/pkg/dist").join(format!("f-{f:03}.js")),
                    vec![1_u8; 512],
                )
                .unwrap();
            }
        }
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        let result = run_quick_cleanup_at(
            roots.clone(),
            &QuickCleanRequest {
                categories: QUICK_CLEAN_ORDER.to_vec(),
            },
            &cancelled,
            &mut |_| {},
        )
        .unwrap();
        let elapsed = started.elapsed();
        eprintln!("BENCH results: {:?}", result.results);
        let files = result.freed_items;
        eprintln!(
            "BENCH: deleted {files} entries in {:.2}s -> {:.0} entries/sec",
            elapsed.as_secs_f64(),
            files as f64 / elapsed.as_secs_f64()
        );
        assert!(elapsed.as_secs() < 60, "deletion too slow: {elapsed:?}");
    }
}
