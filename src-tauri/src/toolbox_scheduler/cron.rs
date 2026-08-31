use std::fmt;

pub(super) const MAX_CRON_BYTES: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SchedulerRuleError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl SchedulerRuleError {
    const fn invalid_cron(message: &'static str) -> Self {
        Self {
            code: "invalid_cron",
            message,
        }
    }

    const fn no_occurrence() -> Self {
        Self {
            code: "no_occurrence",
            message: "This Cron rule cannot occur on any calendar date.",
        }
    }
}

impl fmt::Display for SchedulerRuleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for SchedulerRuleError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CronExpression {
    minute: CronField,
    hour: CronField,
    day_of_month: CronField,
    month: CronField,
    day_of_week: CronField,
}

impl CronExpression {
    pub(crate) fn parse(expression: &str) -> Result<Self, SchedulerRuleError> {
        if expression.is_empty()
            || expression.len() > MAX_CRON_BYTES
            || !expression.is_ascii()
            || expression.trim() != expression
        {
            return Err(SchedulerRuleError::invalid_cron(
                "Cron must be non-empty ASCII, have no surrounding whitespace, and be at most 256 bytes.",
            ));
        }

        let fields = expression.split_ascii_whitespace().collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err(SchedulerRuleError::invalid_cron(
                "Only five-field minute hour day-of-month month day-of-week Cron is supported.",
            ));
        }

        let cron = Self {
            minute: CronField::parse(fields[0], 0, 59, false)?,
            hour: CronField::parse(fields[1], 0, 23, false)?,
            day_of_month: CronField::parse(fields[2], 1, 31, false)?,
            month: CronField::parse(fields[3], 1, 12, false)?,
            day_of_week: CronField::parse(fields[4], 0, 7, true)?,
        };

        if cron.is_statically_impossible() {
            return Err(SchedulerRuleError::no_occurrence());
        }
        Ok(cron)
    }

    pub(crate) fn matches(&self, month: u8, day_of_month: u8, weekday_sunday_zero: u8) -> bool {
        if !self.month.contains(month) {
            return false;
        }

        let dom_matches = self.day_of_month.contains(day_of_month);
        let dow_matches = self.day_of_week.contains(weekday_sunday_zero);
        match (
            self.day_of_month.is_unrestricted(),
            self.day_of_week.is_unrestricted(),
        ) {
            (true, true) => true,
            (true, false) => dow_matches,
            (false, true) => dom_matches,
            // Traditional five-field Cron semantics: when both day fields are restricted,
            // a date matching either field is selected.
            (false, false) => dom_matches || dow_matches,
        }
    }

    pub(crate) fn matches_time(&self, hour: u8, minute: u8) -> bool {
        self.hour.contains(hour) && self.minute.contains(minute)
    }

    fn is_statically_impossible(&self) -> bool {
        // A restricted DOW always has at least one matching day in every selected Gregorian
        // month. DOM can prove an impossibility only when DOW is effectively unrestricted.
        if !self.day_of_week.is_unrestricted() || self.day_of_month.is_unrestricted() {
            return false;
        }

        for month in 1..=12 {
            if !self.month.contains(month) {
                continue;
            }
            let maximum_day = maximum_day_in_month(month);
            if (1..=maximum_day).any(|day| self.day_of_month.contains(day)) {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CronField {
    minimum: u8,
    maximum: u8,
    allowed: u64,
}

impl CronField {
    fn parse(
        field: &str,
        minimum: u8,
        maximum: u8,
        sunday_alias: bool,
    ) -> Result<Self, SchedulerRuleError> {
        if field.is_empty() {
            return Err(invalid_cron_field());
        }

        let mut allowed = 0_u64;
        for item in field.split(',') {
            if item.is_empty() || item.matches('/').count() > 1 {
                return Err(invalid_cron_field());
            }

            let (base, step) = match item.split_once('/') {
                Some((base, step)) if !base.is_empty() && !step.is_empty() => {
                    (base, Some(parse_number(step)?))
                }
                Some(_) => return Err(invalid_cron_field()),
                None => (item, None),
            };
            if step == Some(0) {
                return Err(invalid_cron_field());
            }

            let (start, end) = if base == "*" {
                (minimum, maximum)
            } else if let Some((start, end)) = base.split_once('-') {
                if start.is_empty() || end.is_empty() || end.contains('-') {
                    return Err(invalid_cron_field());
                }
                (parse_number(start)?, parse_number(end)?)
            } else {
                let value = parse_number(base)?;
                (value, value)
            };

            if start < minimum || start > maximum || end < minimum || end > maximum || end < start {
                return Err(invalid_cron_field());
            }

            let step = step.unwrap_or(1);
            for raw_value in (start..=end).step_by(usize::from(step)) {
                let value = if sunday_alias && raw_value == 7 {
                    0
                } else {
                    raw_value
                };
                allowed |= 1_u64 << value;
            }
        }

        Ok(Self {
            minimum,
            maximum: if sunday_alias { 6 } else { maximum },
            allowed,
        })
    }

    fn contains(&self, value: u8) -> bool {
        value >= self.minimum && value <= self.maximum && (self.allowed & (1_u64 << value)) != 0
    }

    fn is_unrestricted(&self) -> bool {
        (self.minimum..=self.maximum).all(|value| self.contains(value))
    }
}

fn parse_number(source: &str) -> Result<u8, SchedulerRuleError> {
    if source.is_empty() || !source.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_cron_field());
    }
    source.parse::<u8>().map_err(|_| invalid_cron_field())
}

fn invalid_cron_field() -> SchedulerRuleError {
    SchedulerRuleError::invalid_cron(
        "Cron fields may use only numbers, *, lists, ranges, and positive steps within field bounds.",
    )
}

fn maximum_day_in_month(month: u8) -> u8 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_product_five_field_dialect() {
        let cron = CronExpression::parse("*/15 8-18/2 1,15 1-12/3 1-5").expect("supported Cron");
        assert!(cron.matches_time(8, 15));
        assert!(!cron.matches_time(9, 15));

        for invalid in [
            "@reboot",
            "0 0 * * * /usr/bin/open",
            "0 0 0 * * *",
            "0 0 * * ?",
            "0 0 * * MON",
            "0 0 * * * ",
        ] {
            assert_eq!(
                CronExpression::parse(invalid)
                    .expect_err("extension is rejected")
                    .code,
                "invalid_cron"
            );
        }
    }

    #[test]
    fn sunday_alias_and_dom_dow_or_semantics_are_explicit() {
        let sunday = CronExpression::parse("0 9 * * 7").expect("Sunday alias is accepted");
        assert!(sunday.matches(6, 1, 0));
        assert!(!sunday.matches(6, 1, 1));

        let or_rule = CronExpression::parse("0 9 31 2 1").expect("DOM and DOW are valid");
        // February 26, 2024 was a Monday even though it is not the 31st.
        assert!(or_rule.matches(2, 26, 1));
        assert!(!or_rule.matches(2, 27, 2));
    }

    #[test]
    fn rejects_calendar_rules_that_can_never_happen() {
        let error = CronExpression::parse("0 0 31 2 *").expect_err("February 31 is impossible");
        assert_eq!(error.code, "no_occurrence");

        // The DOW branch keeps this rule viable under the required DOM/DOW OR semantics.
        assert!(CronExpression::parse("0 0 31 2 1").is_ok());
        assert!(CronExpression::parse("0 0 29 2 *").is_ok());
    }
}
