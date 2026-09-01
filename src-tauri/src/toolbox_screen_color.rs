//! macOS screen color sampling for the local color picker.
//!
//! `NSColorSampler` owns the system sampling UI and calls back with one color
//! value. We never capture, persist, or expose the screen image itself.

use std::{cell::Cell, rc::Rc, sync::mpsc};

use block2::RcBlock;
use objc2::available;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSColor, NSColorSampler, NSColorSpace, NSWindow,
};
use objc2_foundation::MainThreadMarker;
use tauri::{AppHandle, WebviewWindow};

use crate::error::CommandError;

struct AccessoryActivationRestore {
    armed: Cell<bool>,
}

impl AccessoryActivationRestore {
    fn new() -> Self {
        Self {
            armed: Cell::new(false),
        }
    }

    fn arm(&self) {
        self.armed.set(true);
    }

    fn restore(&self) -> Result<(), CommandError> {
        if !self.armed.replace(false) {
            return Ok(());
        }
        let Some(mtm) = MainThreadMarker::new() else {
            self.armed.set(true);
            return Err(CommandError::new(
                "screen_color_activation_restore_failed",
                "The macOS application activation policy could not be restored off the main thread.",
            ));
        };
        let application = NSApplication::sharedApplication(mtm);
        if !application.setActivationPolicy(NSApplicationActivationPolicy::Accessory) {
            self.armed.set(true);
            return Err(CommandError::new(
                "screen_color_activation_restore_failed",
                "macOS refused to restore the application activation policy.",
            ));
        }
        Ok(())
    }
}

impl Drop for AccessoryActivationRestore {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn finish_sampling(
    sampled: Result<Option<String>, CommandError>,
    restored: Result<(), CommandError>,
) -> Result<Option<String>, CommandError> {
    restored?;
    sampled
}

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
    let (start_sender, start_receiver) = mpsc::sync_channel(1);
    let window_for_main = window;
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = start_sender.send(Err(CommandError::new(
                "screen_color_unavailable",
                "The macOS screen color sampler could not start on the main thread.",
            )));
            return;
        };
        let application = NSApplication::sharedApplication(mtm);
        let sampler = NSColorSampler::new();
        let activation_restore = Rc::new(AccessoryActivationRestore::new());
        let activation_restore_for_handler = Rc::clone(&activation_restore);
        let handler = RcBlock::new(move |color: *mut NSColor| {
            let sampled = unsafe { color.as_ref() }.map(color_to_srgb_hex).transpose();
            let result = finish_sampling(sampled, activation_restore_for_handler.restore());
            let _ = sender.send(result);
        });

        if application.activationPolicy() == NSApplicationActivationPolicy::Accessory {
            // Accessory/menu-bar apps cannot reliably present AppKit's
            // screen sampler while they remain non-regular applications.
            if !application.setActivationPolicy(NSApplicationActivationPolicy::Regular) {
                let _ = start_sender.send(Err(CommandError::new(
                    "screen_color_unavailable",
                    "macOS refused to activate the screen color sampler.",
                )));
                return;
            }
            activation_restore.arm();
        }

        if let Ok(ns_window) = window_for_main.ns_window()
            && let Some(ns_window) = unsafe { ns_window.cast::<NSWindow>().as_ref() }
        {
            ns_window.makeKeyAndOrderFront(None);
        }
        // Force the host app to the foreground before AppKit presents its
        // sampler. This is required when the app was opened from the menu
        // bar or was launched as a background accessory.
        #[allow(deprecated)]
        application.activateIgnoringOtherApps(true);

        // NSColorSampler retains itself until the selection handler finishes.
        unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
        let _ = start_sender.send(Ok(()));
    })
    .map_err(|error| {
        CommandError::new(
            "screen_color_unavailable",
            format!("Could not start the macOS screen color sampler: {error}"),
        )
    })?;

    start_receiver.recv().map_err(|_| {
        CommandError::new(
            "screen_color_unavailable",
            "The macOS screen color sampler stopped while starting.",
        )
    })??;
    tauri::async_runtime::spawn_blocking(move || {
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
    })??
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
    use super::{color_component_to_byte, finish_sampling};
    use crate::error::CommandError;

    #[test]
    fn color_components_are_clamped_and_rounded() {
        assert_eq!(color_component_to_byte(-0.1), 0);
        assert_eq!(color_component_to_byte(0.5), 128);
        assert_eq!(color_component_to_byte(1.2), 255);
    }

    #[test]
    fn sampling_completion_preserves_cancellation_after_restoration() {
        assert_eq!(finish_sampling(Ok(None), Ok(())).unwrap(), None);
    }

    #[test]
    fn sampling_completion_surfaces_restoration_failures() {
        let restored = Err(CommandError::new("restore_failed", "restore failed"));
        assert!(finish_sampling(Ok(Some("#112233".to_owned())), restored).is_err());
    }
}
