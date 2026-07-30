// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if core_robin_lib::maybe_run_cleanup_scan_worker() {
        return;
    }
    core_robin_lib::run()
}
