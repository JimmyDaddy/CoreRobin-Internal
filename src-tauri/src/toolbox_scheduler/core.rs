//! Private schedule-rule parsing, time-zone and bounded-search primitives.
//!
//! The parent `toolbox_scheduler.rs` consumes this module without exposing another public Tauri
//! or client contract. It lets the scheduler migrate from temporary `nextRunAtMs` drafts while
//! retaining the already-submitted AppState construction path.

mod cron;
mod search;
mod timezone;

pub(super) use cron::{CronExpression, SchedulerRuleError};
pub(super) use search::{CronSearchResult, SearchBudget, search_cron};
pub(super) use timezone::{
    LocalCalendarKey, ResolvedLocalTime, local_calendar_key_at, parse_time_zone, resolve_local_time,
};
