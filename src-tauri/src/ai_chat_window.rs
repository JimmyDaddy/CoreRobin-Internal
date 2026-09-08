//! Window presentation only. Conversation contents and requests belong to AiService.
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
};

use crate::error::CommandError;

const CHAT_LABEL: &str = "robin-chat";
pub const NAVIGATION_EVENT: &str = "core-robin:ai-navigation";
pub const VISIBILITY_EVENT: &str = "core-robin:ai-chat-visibility";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatNavigation {
    pub token: u64,
    pub session_id: Option<String>,
    pub settings: bool,
    pub position: Option<MessagePosition>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePosition {
    pub before: Option<u32>,
    pub anchor_id: Option<String>,
    pub anchor_offset: f64,
}

#[derive(Default)]
struct NavigationState {
    next_token: u64,
    pending: Option<ChatNavigation>,
}

#[derive(Default)]
pub struct ChatWindowState {
    navigation: Mutex<NavigationState>,
    // Creation runs in an asynchronous command; serialize double clicks before a window exists.
    creation: tokio::sync::Mutex<()>,
}

fn allowed(window: &WebviewWindow, labels: &[&str]) -> Result<(), CommandError> {
    if labels.contains(&window.label()) {
        Ok(())
    } else {
        Err(CommandError::new(
            "ai_window_forbidden",
            "This window cannot perform this action.",
        ))
    }
}

fn window_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        "ai_window_unavailable",
        format!("Could not open the assistant: {error}"),
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn placement(
    bird: PhysicalPosition<i32>,
    bird_size: PhysicalSize<u32>,
    origin: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    scale: f64,
) -> Placement {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let gap = (12.0 * scale).round() as i64;
    let margin = (8.0 * scale).round() as i64;
    let width = (400.0 * scale).round() as i64;
    let height = (540.0 * scale).round() as i64;
    let width = width.min((i64::from(area.width) - 2 * margin).max(1));
    let height = height.min((i64::from(area.height) - 2 * margin).max(1));
    let min_x = i64::from(origin.x) + margin.min(i64::from(area.width) / 2);
    let min_y = i64::from(origin.y) + margin.min(i64::from(area.height) / 2);
    let max_x = (i64::from(origin.x) + i64::from(area.width) - width - margin).max(min_x);
    let max_y = (i64::from(origin.y) + i64::from(area.height) - height - margin).max(min_y);
    // Prefer above the bird. At the top edge use the side with the larger free space.
    let above = i64::from(bird.y) - gap - height;
    let right = i64::from(bird.x) + i64::from(bird_size.width) + gap;
    let left = i64::from(bird.x) - gap - width;
    let (x, y) = if above >= min_y {
        (
            i64::from(bird.x) + i64::from(bird_size.width) - width,
            above,
        )
    } else if right + width <= i64::from(origin.x) + i64::from(area.width) - margin {
        (right, i64::from(bird.y))
    } else {
        (left, i64::from(bird.y))
    };
    Placement {
        x: x.clamp(min_x, max_x) as i32,
        y: y.clamp(min_y, max_y) as i32,
        width: width as u32,
        height: height as u32,
    }
}

pub fn reposition(app: &AppHandle) -> Result<(), CommandError> {
    let Some(chat) = app.get_webview_window(CHAT_LABEL) else {
        return Ok(());
    };
    let bird = app
        .get_webview_window("companion")
        .ok_or_else(|| window_error("Robin is unavailable"))?;
    let monitor = bird
        .current_monitor()
        .map_err(window_error)?
        .or(app.primary_monitor().map_err(window_error)?)
        .ok_or_else(|| window_error("No display is available"))?;
    let work = monitor.work_area();
    let target = placement(
        bird.outer_position().map_err(window_error)?,
        bird.outer_size().map_err(window_error)?,
        work.position,
        work.size,
        monitor.scale_factor(),
    );
    chat.set_size(PhysicalSize::new(target.width, target.height))
        .map_err(window_error)?;
    chat.set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(window_error)?;
    Ok(())
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CHAT_LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit_to("companion", VISIBILITY_EVENT, false);
    let _ = app.emit_to(CHAT_LABEL, VISIBILITY_EVENT, false);
}

#[tauri::command]
pub async fn toggle_ai_chat_window(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, ChatWindowState>,
) -> Result<bool, CommandError> {
    allowed(&window, &["main", "companion"])?;
    let _creation = state.creation.lock().await;
    let chat = if let Some(chat) = app.get_webview_window(CHAT_LABEL) {
        if chat.is_visible().map_err(window_error)? {
            hide(&app);
            return Ok(false);
        }
        chat
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            CHAT_LABEL,
            WebviewUrl::App("robin-chat.html".into()),
        )
        .title("Robin")
        .inner_size(400.0, 540.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(window_error)?
    };
    // A normal window stays in the active workspace. Do not apply the companion's all-spaces panel behavior.
    reposition(&app)?;
    chat.show().map_err(window_error)?;
    chat.set_focus().map_err(window_error)?;
    let _ = app.emit_to("companion", VISIBILITY_EVENT, true);
    let _ = app.emit_to(CHAT_LABEL, VISIBILITY_EVENT, true);
    Ok(true)
}

#[tauri::command]
pub fn hide_ai_chat_window(window: WebviewWindow, app: AppHandle) -> Result<(), CommandError> {
    allowed(&window, &["main", "companion", CHAT_LABEL])?;
    hide(&app);
    Ok(())
}

#[tauri::command]
pub fn ai_chat_continue_in_main(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, ChatWindowState>,
    session_id: Option<String>,
    settings: bool,
    position: Option<MessagePosition>,
) -> Result<ChatNavigation, CommandError> {
    allowed(&window, &["main", CHAT_LABEL])?;
    if position.as_ref().is_some_and(|position| {
        position.before.is_some_and(|before| before > 1000)
            || !position.anchor_offset.is_finite()
            || position.anchor_offset.abs() > 1_000_000.0
            || position
                .anchor_id
                .as_ref()
                .is_some_and(|id| id.len() > 128 || id.chars().any(char::is_control))
    }) {
        return Err(CommandError::new(
            "ai_position_invalid",
            "Invalid conversation position.",
        ));
    }
    if session_id
        .as_ref()
        .is_some_and(|id| id.len() > 128 || id.is_empty())
    {
        return Err(CommandError::new(
            "ai_session_invalid",
            "Invalid conversation identifier.",
        ));
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| window_error("The main window is unavailable"))?;
    let navigation = {
        let mut registry = state.navigation.lock().map_err(window_error)?;
        registry.next_token = registry.next_token.saturating_add(1);
        let pending = ChatNavigation {
            token: registry.next_token,
            session_id,
            settings,
            position,
        };
        registry.pending = Some(pending.clone());
        pending
    };
    crate::show_main(&app);
    // Unlike normal menu navigation, handoff must report a failed reveal. Do not
    // close the only usable conversation view after a hidden WebView loads data.
    main.unminimize().map_err(window_error)?;
    main.show().map_err(window_error)?;
    main.set_focus().map_err(window_error)?;
    // This is only a wakeup. The pending navigation remains queryable after a lost event or reload.
    let _ = app.emit_to("main", NAVIGATION_EVENT, ());
    Ok(navigation)
}

#[tauri::command]
pub fn ai_chat_get_navigation(
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
) -> Result<Option<ChatNavigation>, CommandError> {
    allowed(&window, &["main"])?;
    Ok(state
        .navigation
        .lock()
        .map_err(window_error)?
        .pending
        .clone())
}

#[tauri::command]
pub fn ai_chat_ack_navigation(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, ChatWindowState>,
    token: u64,
) -> Result<(), CommandError> {
    allowed(&window, &["main"])?;
    let mut registry = state.navigation.lock().map_err(window_error)?;
    if registry
        .pending
        .as_ref()
        .is_some_and(|pending| pending.token == token)
    {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| window_error("The main window is unavailable"))?;
        if !main.is_visible().map_err(window_error)? || main.is_minimized().map_err(window_error)? {
            return Err(window_error(
                "The main window could not become visible. The chat window remains available.",
            ));
        }
        registry.pending = None;
        hide(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placement_fits_negative_origin_and_mixed_scale() {
        for scale in [1.0, 1.25, 2.0] {
            let origin = PhysicalPosition::new(-1920, 48);
            let area = PhysicalSize::new(1920, 1032);
            for bird in [
                PhysicalPosition::new(-1910, 50),
                PhysicalPosition::new(-92, 980),
                PhysicalPosition::new(-960, 540),
            ] {
                let placed = placement(bird, PhysicalSize::new(92, 92), origin, area, scale);
                assert!(placed.x >= origin.x && placed.y >= origin.y);
                assert!(i64::from(placed.x) + i64::from(placed.width) <= 0);
                assert!(i64::from(placed.y) + i64::from(placed.height) <= 1080);
            }
        }
    }

    #[test]
    fn small_displays_limit_window_instead_of_covering_offscreen_pixels() {
        let placed = placement(
            PhysicalPosition::new(10, 10),
            PhysicalSize::new(92, 92),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(320, 400),
            2.0,
        );
        assert!(placed.width <= 320 && placed.height <= 400);
        assert!(placed.x >= 0 && placed.y >= 0);
        assert!(placed.x as u32 + placed.width <= 320);
        assert!(placed.y as u32 + placed.height <= 400);
    }
}
