use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use status_orbit_lib::{benchmark_cleanup_root, benchmark_cleanup_root_with_cancel};

fn main() -> Result<(), String> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, root] if command == "scan" => scan(Path::new(root)),
        [command, root, delay_ms] if command == "cancel" => {
            let delay_ms = delay_ms
                .parse::<u64>()
                .map_err(|_| "Cancellation delay must be an integer number of milliseconds.")?;
            cancel(PathBuf::from(root), delay_ms)
        }
        [command, root] if command == "create-fixture" => {
            create_fixture(Path::new(root), 100_000)
        }
        [command, root, entries] if command == "create-fixture" => {
            let entries = entries
                .parse::<usize>()
                .map_err(|_| "Fixture entry count must be a positive integer.")?;
            create_fixture(Path::new(root), entries)
        }
        _ => Err(
            "Usage: cargo run --example cleanup-benchmark -- <scan ROOT|cancel ROOT DELAY_MS|create-fixture ROOT [ENTRIES]>"
                .to_owned(),
        ),
    }
}

fn scan(root: &Path) -> Result<(), String> {
    let result = benchmark_cleanup_root(root)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result)
            .map_err(|error| format!("Could not serialize benchmark result: {error}"))?
    );
    Ok(())
}

fn cancel(root: PathBuf, delay_ms: u64) -> Result<(), String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker =
        thread::spawn(move || benchmark_cleanup_root_with_cancel(&root, &worker_cancelled));
    thread::sleep(Duration::from_millis(delay_ms));
    let cancellation_started_at = Instant::now();
    cancelled.store(true, Ordering::Relaxed);
    let result = worker
        .join()
        .map_err(|_| "Cleanup benchmark worker panicked.".to_owned())?;
    println!(
        "{{\n  \"cancellationLatencyMs\": {},\n  \"workerResult\": {}\n}}",
        cancellation_started_at.elapsed().as_millis(),
        serde_json::to_string(&result)
            .map_err(|error| format!("Could not serialize cancellation result: {error}"))?
    );
    Ok(())
}

fn create_fixture(root: &Path, entries: usize) -> Result<(), String> {
    if entries == 0 {
        return Err("Fixture entry count must be greater than zero.".to_owned());
    }
    if root.exists() {
        let mut existing = fs::read_dir(root).map_err(|error| {
            format!("Could not inspect fixture root {}: {error}", root.display())
        })?;
        if existing.next().is_some() {
            return Err(format!(
                "Fixture root must be absent or empty: {}",
                root.display()
            ));
        }
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create fixture root {}: {error}", root.display()))?;
    for index in 0..entries {
        let bucket = root.join(format!("bucket-{:04}", index % 1_000));
        fs::create_dir_all(&bucket)
            .map_err(|error| format!("Could not create {}: {error}", bucket.display()))?;
        fs::write(bucket.join(format!("entry-{index:06}.bin")), [index as u8])
            .map_err(|error| format!("Could not write fixture entry {index}: {error}"))?;
    }
    let mut deep = root.join("deep");
    for depth in 0..128 {
        deep = deep.join(format!("d{depth:02x}"));
    }
    fs::create_dir_all(&deep).map_err(|error| format!("Could not create deep fixture: {error}"))?;
    fs::write(deep.join("leaf.bin"), b"deep")
        .map_err(|error| format!("Could not write deep fixture leaf: {error}"))?;
    println!(
        "Created deterministic cleanup fixture with {entries} flat entries and one 128-level tree at {}.",
        root.display()
    );
    Ok(())
}
