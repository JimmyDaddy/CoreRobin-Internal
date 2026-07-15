#[path = "src/command_names.rs"]
mod command_names;

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(command_names::ALL_COMMANDS)),
    )
    .expect("failed to build StatusOrbit's Tauri application manifest");
}
