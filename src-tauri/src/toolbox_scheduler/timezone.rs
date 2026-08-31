use std::str::FromStr;

use chrono::{DateTime, Datelike, LocalResult, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

use super::SchedulerRuleError;

const MAX_TIME_ZONE_BYTES: usize = 128;

#[derive(
    Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalCalendarKey {
    pub(crate) year: i32,
    pub(crate) month: u32,
    pub(crate) day: u32,
    pub(crate) hour: u32,
    pub(crate) minute: u32,
}

impl LocalCalendarKey {
    fn from_naive(local: NaiveDateTime) -> Self {
        Self {
            year: local.year(),
            month: local.month(),
            day: local.day(),
            hour: local.hour(),
            minute: local.minute(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedLocalTime {
    pub(crate) at_utc: DateTime<Utc>,
    pub(crate) local_key: LocalCalendarKey,
}

/// Parse a named IANA zone; scheduling never inherits the mutable host zone.
pub(crate) fn parse_time_zone(source: &str) -> Result<Tz, SchedulerRuleError> {
    if source.is_empty()
        || source.len() > MAX_TIME_ZONE_BYTES
        || source.trim() != source
        || !source.is_ascii()
    {
        return Err(invalid_time_zone());
    }
    Tz::from_str(source).map_err(|_| invalid_time_zone())
}

/// Resolve one local calendar minute under the product DST policy.
///
/// A DST gap has no scheduled instant. For a fall-back overlap, the earlier UTC instant is the
/// one and only execution of the local calendar minute; `local_key` remains available for
/// durable duplicate suppression across wall-clock or tzdb recalculation.
pub(crate) fn resolve_local_time(time_zone: Tz, local: NaiveDateTime) -> Option<ResolvedLocalTime> {
    let selected = match time_zone.from_local_datetime(&local) {
        LocalResult::None => return None,
        LocalResult::Single(value) => value,
        LocalResult::Ambiguous(first, second) => first.min(second),
    };
    Some(ResolvedLocalTime {
        at_utc: selected.with_timezone(&Utc),
        local_key: LocalCalendarKey::from_naive(local),
    })
}

fn invalid_time_zone() -> SchedulerRuleError {
    SchedulerRuleError {
        code: "invalid_time_zone",
        message: "timeZone must be a supported IANA time-zone identifier.",
    }
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, TimeZone, Utc};

    use super::*;

    #[test]
    fn accepts_iana_zones_and_rejects_host_or_invalid_identifiers() {
        assert_eq!(
            parse_time_zone("America/New_York")
                .expect("IANA zone")
                .to_string(),
            "America/New_York"
        );
        for invalid in ["", " local ", "Local", "GMT+8", "America/NotAZone"] {
            assert_eq!(
                parse_time_zone(invalid)
                    .expect_err("invalid zone does not fall back to host settings")
                    .code,
                "invalid_time_zone"
            );
        }
    }

    #[test]
    fn skips_dst_gap_and_selects_one_instant_for_dst_overlap() {
        let zone = parse_time_zone("America/New_York").expect("IANA zone");
        let gap = NaiveDate::from_ymd_opt(2024, 3, 10)
            .expect("valid date")
            .and_hms_opt(2, 30, 0)
            .expect("valid local time");
        assert!(resolve_local_time(zone, gap).is_none());

        let repeated = NaiveDate::from_ymd_opt(2024, 11, 3)
            .expect("valid date")
            .and_hms_opt(1, 30, 0)
            .expect("valid local time");
        let resolved = resolve_local_time(zone, repeated).expect("ambiguous time resolves once");
        assert_eq!(
            resolved.at_utc,
            Utc.with_ymd_and_hms(2024, 11, 3, 5, 30, 0)
                .single()
                .expect("known UTC instant")
        );
        assert_eq!(resolved.local_key.hour, 1);
        assert_eq!(resolved.local_key.minute, 30);
    }
}
