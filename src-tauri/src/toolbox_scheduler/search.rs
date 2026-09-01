use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Months, TimeZone, Utc};
use chrono_tz::Tz;

use super::{CronExpression, ResolvedLocalTime, resolve_local_time};

pub(crate) const MAX_PREVIEW_OCCURRENCES: usize = 10;
pub(crate) const MAX_SEARCH_YEARS: u32 = 5;
const MAX_CALENDAR_CANDIDATES: usize = 100_000;

#[derive(Clone, Debug)]
pub(crate) struct SearchBudget {
    deadline: Instant,
}

impl SearchBudget {
    pub(crate) fn normal() -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(1),
        }
    }

    #[cfg(test)]
    fn expired() -> Self {
        Self {
            deadline: Instant::now(),
        }
    }

    fn exhausted(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CronSearchResult {
    Occurrences {
        occurrences: Vec<ResolvedLocalTime>,
        horizon_end_utc: DateTime<Utc>,
        truncated: bool,
    },
    NoOccurrenceInHorizon {
        horizon_end_utc: DateTime<Utc>,
    },
    SearchLimit,
}

/// Enumerate a bounded, local-civil-time Cron preview without sleeping or scheduling work.
///
/// The caller owns the executor. It may run this on an isolated search worker, supply a
/// cancellation probe, and must never reuse an old candidate after `SearchLimit`.
pub(crate) fn search_cron<F>(
    expression: &CronExpression,
    time_zone: Tz,
    after_utc: DateTime<Utc>,
    budget: SearchBudget,
    mut is_cancelled: F,
) -> CronSearchResult
where
    F: FnMut() -> bool,
{
    let horizon_end_utc = after_utc
        .checked_add_months(Months::new(MAX_SEARCH_YEARS * 12))
        .unwrap_or(after_utc);
    let start_date = time_zone
        .from_utc_datetime(&after_utc.naive_utc())
        .date_naive();
    let end_date = time_zone
        .from_utc_datetime(&horizon_end_utc.naive_utc())
        .date_naive();

    let mut occurrences = Vec::with_capacity(MAX_PREVIEW_OCCURRENCES);
    let mut calendar_candidates = 0_usize;
    let mut inspected_dates = 0_usize;
    let mut date = start_date;

    loop {
        if inspected_dates.is_multiple_of(32) && (budget.exhausted() || is_cancelled()) {
            return CronSearchResult::SearchLimit;
        }
        if date > end_date {
            break;
        }
        inspected_dates = inspected_dates.saturating_add(1);

        if expression.matches(
            date.month() as u8,
            date.day() as u8,
            date.weekday().num_days_from_sunday() as u8,
        ) {
            for hour in 0..24 {
                for minute in 0..60 {
                    if !expression.matches_time(hour, minute) {
                        continue;
                    }
                    calendar_candidates = calendar_candidates.saturating_add(1);
                    if calendar_candidates > MAX_CALENDAR_CANDIDATES
                        || budget.exhausted()
                        || is_cancelled()
                    {
                        return CronSearchResult::SearchLimit;
                    }

                    let Some(local) = date.and_hms_opt(u32::from(hour), u32::from(minute), 0)
                    else {
                        continue;
                    };
                    let Some(resolved) = resolve_local_time(time_zone, local) else {
                        // Nonexistent local minutes during a DST gap are skipped, never shifted.
                        continue;
                    };
                    if resolved.at_utc <= after_utc || resolved.at_utc > horizon_end_utc {
                        continue;
                    }
                    occurrences.push(resolved);
                    if occurrences.len() == MAX_PREVIEW_OCCURRENCES {
                        return CronSearchResult::Occurrences {
                            occurrences,
                            horizon_end_utc,
                            truncated: true,
                        };
                    }
                }
            }
        }

        let Some(next_date) = date.checked_add_signed(ChronoDuration::days(1)) else {
            break;
        };
        date = next_date;
    }

    if occurrences.is_empty() {
        CronSearchResult::NoOccurrenceInHorizon { horizon_end_utc }
    } else {
        CronSearchResult::Occurrences {
            occurrences,
            horizon_end_utc,
            truncated: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::toolbox_scheduler::scheduler_core::parse_time_zone;

    fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("valid UTC test time")
    }

    #[test]
    fn returns_at_most_ten_candidates_inside_the_fixed_horizon() {
        let expression = CronExpression::parse("* * * * *").expect("valid Cron");
        let result = search_cron(
            &expression,
            parse_time_zone("Etc/UTC").expect("zone"),
            utc(2025, 1, 1, 0, 0),
            SearchBudget::normal(),
            || false,
        );

        let CronSearchResult::Occurrences {
            occurrences,
            truncated,
            ..
        } = result
        else {
            panic!("dense rule returns preview occurrences");
        };
        assert_eq!(occurrences.len(), MAX_PREVIEW_OCCURRENCES);
        assert!(truncated);
        assert!(
            occurrences
                .windows(2)
                .all(|pair| pair[0].at_utc < pair[1].at_utc)
        );
    }

    #[test]
    fn preserves_dom_dow_or_when_searching() {
        let expression = CronExpression::parse("0 9 31 2 1").expect("valid OR rule");
        let result = search_cron(
            &expression,
            parse_time_zone("Etc/UTC").expect("zone"),
            utc(2024, 2, 1, 0, 0),
            SearchBudget::normal(),
            || false,
        );
        let CronSearchResult::Occurrences { occurrences, .. } = result else {
            panic!("Monday occurrence exists despite February never having a 31st");
        };
        assert!(occurrences.iter().any(|entry| entry.local_key.day != 31));
    }

    #[test]
    fn skips_a_dst_gap_and_deduplicates_a_repeated_local_minute() {
        let expression = CronExpression::parse("30 1 3 11 *").expect("valid Cron");
        let result = search_cron(
            &expression,
            parse_time_zone("America/New_York").expect("zone"),
            utc(2024, 11, 3, 4, 0),
            SearchBudget::normal(),
            || false,
        );
        let CronSearchResult::Occurrences { occurrences, .. } = result else {
            panic!("fall-back local minute has one scheduled instant");
        };
        assert_eq!(occurrences[0].at_utc, utc(2024, 11, 3, 5, 30));
        assert_eq!(
            occurrences
                .iter()
                .filter(|entry| entry.local_key.year == 2024)
                .count(),
            1
        );
    }

    #[test]
    fn distinguishes_horizon_exhaustion_from_search_limit() {
        let leap_day = CronExpression::parse("0 0 29 2 *").expect("valid sparse rule");
        let no_window = search_cron(
            &leap_day,
            parse_time_zone("Etc/UTC").expect("zone"),
            utc(2096, 3, 1, 0, 0),
            SearchBudget::normal(),
            || false,
        );
        assert!(matches!(
            no_window,
            CronSearchResult::NoOccurrenceInHorizon { .. }
        ));

        let limit = search_cron(
            &CronExpression::parse("0 0 * * *").expect("valid rule"),
            parse_time_zone("Etc/UTC").expect("zone"),
            utc(2025, 1, 1, 0, 0),
            SearchBudget::expired(),
            || false,
        );
        assert!(matches!(limit, CronSearchResult::SearchLimit));
    }
}
