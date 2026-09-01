//! macOS screen color sampling for the local color picker.
//!
//! `NSColorSampler` owns the system sampling UI and calls back with one color
//! value. We never capture, persist, or expose the screen image itself.

use std::sync::mpsc;

use block2::RcBlock;
use objc2::available;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSColor, NSColorSampler, NSColorSpace, NSWindow,
};
use objc2_foundation::MainThreadMarker;
use tauri::{AppHandle, WebviewWindow};

use crate::error::CommandError;

pub async fn pick_screen_color(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Option<String>, CommandError> {
    if !available!(macos = 10.15) {
        return Err(CommandError::new(
            "screen_color_unsupported",
            "Screen color sampling requires macOS 10.15 or later.",
        ));
    }

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    let (sender, receiver) = mpsc::sync_channel(1);
    let (restore_sender, restore_receiver) = mpsc::sync_channel(1);
    let window_for_main = window;
    app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            if let Ok(ns_window) = window_for_main.ns_window()
                && let Some(ns_window) = unsafe { ns_window.cast::<NSWindow>().as_ref() }
            {
                ns_window.makeKeyAndOrderFront(None);
            }
            let application = NSApplication::sharedApplication(mtm);
            let was_accessory =
                application.activationPolicy() == NSApplicationActivationPolicy::Accessory;
            if was_accessory {
                // Accessory/menu-bar apps cannot reliably present AppKit's
                // screen sampler while they remain non-regular applications.
                let _ = application.setActivationPolicy(NSApplicationActivationPolicy::Regular);
            }
            let _ = restore_sender.send(was_accessory);

            // Force the host app to the foreground before AppKit presents its
            // sampler. This is required when the app was opened from the menu
            // bar or was launched as a background accessory.
            #[allow(deprecated)]
            application.activateIgnoringOtherApps(true);
        } else {
            let _ = restore_sender.send(false);
        }

        let sampler = NSColorSampler::new();
        let handler = RcBlock::new(move |color: *mut NSColor| {
            let result = unsafe { color.as_ref() }.map(color_to_srgb_hex).transpose();
            let _ = sender.send(result);
        });

        // NSColorSampler retains itself until the selection handler finishes.
        unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
    })
    .map_err(|error| {
        CommandError::new(
            "screen_color_unavailable",
            format!("Could not start the macOS screen color sampler: {error}"),
        )
    })?;

    let restore_accessory = restore_receiver.recv().unwrap_or(false);
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|_| {
            CommandError::new(
                "screen_color_unavailable",
                "The macOS screen color sampler stopped before returning a color.",
            )
        })
    })
    .await
    .map_err(|_| {
        CommandError::new(
            "screen_color_unavailable",
            "The macOS screen color sampler stopped unexpectedly.",
        )
    })??;
    let result = result?;

    if restore_accessory {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    Ok(result)
}

fn color_to_srgb_hex(color: &NSColor) -> Result<String, CommandError> {
    let srgb_space = NSColorSpace::sRGBColorSpace();
    let color = color.colorUsingColorSpace(&srgb_space).ok_or_else(|| {
        CommandError::new(
            "screen_color_conversion_failed",
            "The sampled color could not be converted to sRGB.",
        )
    })?;
    let mut red = 0.0;
    let mut green = 0.0;
    let mut blue = 0.0;
    unsafe {
        color.getRed_green_blue_alpha(&mut red, &mut green, &mut blue, std::ptr::null_mut());
    }
    Ok(format!(
        "#{:02x}{:02x}{:02x}",
        color_component_to_byte(red),
        color_component_to_byte(green),
        color_component_to_byte(blue),
    ))
}

fn color_component_to_byte(value: f64) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::color_component_to_byte;

    #[test]
    fn color_components_are_clamped_and_rounded() {
        assert_eq!(color_component_to_byte(-0.1), 0);
        assert_eq!(color_component_to_byte(0.5), 128);
        assert_eq!(color_component_to_byte(1.2), 255);
    }
}
