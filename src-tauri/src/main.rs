// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if core_robin_lib::maybe_run_cleanup_scan_worker() {
        return;
    }
    if std::env::args_os().any(|argument| argument == "--keyboard-helper") {
        std::process::exit(core_robin_lib::run_keyboard_helper());
    }
    core_robin_lib::run()
}
