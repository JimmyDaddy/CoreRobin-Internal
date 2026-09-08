//! The page and assistant share one coordinator, cancellation token and result.
use crate::{AppState, cleanup, error::CommandError, models::*};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager, ipc::Channel};

struct Operation {
    coordinator: Arc<cleanup::QuickCleanCoordinator>,
    token: Arc<AtomicBool>,
    results: Arc<crate::application_capabilities::ApplicationResults>,
}
impl Drop for Operation {
    fn drop(&mut self) {
        // The blocking worker owns the concurrency slot, including if the
        // invoking future is cancelled or the worker unwinds.
        if self.coordinator.update(&self.token, |view| {
            if matches!(
                view.phase,
                QuickCleanPhase::Analyzing | QuickCleanPhase::Cleaning
            ) {
                view.phase = QuickCleanPhase::Idle;
                view.error = Some(CommandError::internal("Quick cleanup worker stopped."));
            }
        }) {
            self.results.quick_clean_changed();
        }
        self.coordinator.finish(&self.token);
    }
}

pub async fn analyze(
    app: AppHandle,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Vec<QuickCleanCategorySummary>, CommandError> {
    let state = app.state::<AppState>();
    let ai = app.state::<crate::ai_commands::AiRuntime>();
    let gate = ai.context_gate.read().await;
    ai.require_source_ready()
        .map_err(|error| CommandError::new(error.code, error.message))?;
    let coordinator = state.quick_clean.clone();
    let token = coordinator
        .begin_with_cancel(cancel.unwrap_or_else(|| Arc::new(AtomicBool::new(false))))?;
    coordinator.start_view(&token, true);
    drop(gate);
    let results = state.application_results.clone();
    results.quick_clean_changed();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = Operation {
            coordinator: coordinator.clone(),
            token: token.clone(),
            results: results.clone(),
        };
        let outcome = cleanup::analyze_quick_cleanup_cancellable(&token);
        if coordinator.update(&token, |view| {
            view.cancelled = token.load(Ordering::Acquire);
            match &outcome {
                Ok(summaries) => {
                    view.summaries = summaries.clone();
                    view.phase = if summaries.iter().any(|summary| summary.available) {
                        QuickCleanPhase::Selection
                    } else {
                        QuickCleanPhase::Done
                    };
                }
                Err(error) => {
                    view.error = Some(error.clone());
                    view.phase = QuickCleanPhase::Idle;
                }
            }
        }) {
            results.quick_clean_changed();
        }
        outcome
    })
    .await
    .map_err(|_| CommandError::internal("Quick cleanup analysis worker stopped."))?
}

pub async fn run(
    app: AppHandle,
    request: QuickCleanRequest,
    on_progress: Channel<QuickCleanProgress>,
) -> Result<QuickCleanResult, CommandError> {
    let state = app.state::<AppState>();
    let ai = app.state::<crate::ai_commands::AiRuntime>();
    let gate = ai.context_gate.read().await;
    ai.require_source_ready()
        .map_err(|error| CommandError::new(error.code, error.message))?;
    let coordinator = state.quick_clean.clone();
    let token = coordinator.begin()?;
    coordinator.start_view(&token, false);
    drop(gate);
    let results = state.application_results.clone();
    results.quick_clean_changed();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = Operation {
            coordinator: coordinator.clone(),
            token: token.clone(),
            results: results.clone(),
        };
        let mut last_notification = std::time::Instant::now();
        let mut changed_disk = false;
        let outcome = cleanup::run_quick_cleanup(&request, &token, &mut |progress| {
            changed_disk |= progress.freed_items > 0;
            let accepted = coordinator.update(&token, |view| {
                view.progress = Some(progress.clone());
            });
            if accepted {
                let _ = on_progress.send(progress);
            }
            if accepted && last_notification.elapsed().as_millis() >= 100 {
                results.quick_clean_changed();
                last_notification = std::time::Instant::now();
            }
        });
        changed_disk |= outcome.as_ref().is_ok_and(|result| result.freed_items > 0);
        if coordinator.update(&token, |view| {
            view.cancelled = token.load(Ordering::Acquire);
            view.phase = QuickCleanPhase::Done;
            match &outcome {
                Ok(result) => view.result = Some(result.clone()),
                Err(error) => view.error = Some(error.clone()),
            }
        }) {
            results.quick_clean_changed();
        }
        if changed_disk {
            results.disk_invalidated();
        }
        outcome
    })
    .await
    .map_err(|_| CommandError::internal("Quick cleanup worker stopped."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_unwind_leaves_a_recoverable_shared_state() {
        let coordinator = Arc::new(cleanup::QuickCleanCoordinator::default());
        let token = coordinator.begin().unwrap();
        coordinator.start_view(&token, true);
        let results = Arc::new(crate::application_capabilities::ApplicationResults::default());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _operation = Operation {
                coordinator: coordinator.clone(),
                token,
                results,
            };
            panic!("synthetic worker failure");
        }));
        assert!(result.is_err());
        let snapshot = coordinator.snapshot().unwrap();
        assert!(matches!(snapshot.phase, QuickCleanPhase::Idle));
        assert!(snapshot.error.is_some());
        assert!(coordinator.begin().is_ok());
    }
}
