use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::Components;

use crate::models::{
    BatterySnapshot, BatteryState, PowerSource, SensorsSnapshot, SleepBlocker, SleepBlockerKind,
    SleepSnapshot, TemperatureSnapshot,
};

const SENSOR_REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const SLEEP_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

pub struct SensorSampler {
    components: Components,
    last_refresh: Instant,
    snapshot: SensorsSnapshot,
    sleep: Arc<Mutex<SleepSnapshot>>,
}

impl SensorSampler {
    pub fn new() -> Self {
        let components = Components::new_with_refreshed_list();
        let sleep = start_sleep_sampler();
        let snapshot = sample_sensors(&components, &sleep);
        Self {
            components,
            last_refresh: Instant::now(),
            snapshot,
            sleep,
        }
    }

    pub fn sample(&mut self) -> SensorsSnapshot {
        if self.last_refresh.elapsed() >= SENSOR_REFRESH_INTERVAL {
            self.components.refresh(true);
            self.snapshot = sample_sensors(&self.components, &self.sleep);
            self.last_refresh = Instant::now();
        }
        self.snapshot.sleep = cached_sleep_snapshot(&self.sleep);
        self.snapshot.clone()
    }
}

fn sample_sensors(components: &Components, sleep: &Arc<Mutex<SleepSnapshot>>) -> SensorsSnapshot {
    SensorsSnapshot {
        sampled_at_ms: now_millis(),
        temperature: hottest_temperature(components),
        battery: sample_battery(),
        sleep: cached_sleep_snapshot(sleep),
    }
}

fn cached_sleep_snapshot(sleep: &Arc<Mutex<SleepSnapshot>>) -> SleepSnapshot {
    sleep
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_else(|_| unavailable_sleep())
}

fn start_sleep_sampler() -> Arc<Mutex<SleepSnapshot>> {
    let snapshot = Arc::new(Mutex::new(unavailable_sleep()));
    let worker = Arc::downgrade(&snapshot);
    let _ = thread::Builder::new()
        .name("pulse-sleep-assertions".to_owned())
        .spawn(move || run_sleep_sampler(worker));
    snapshot
}

fn run_sleep_sampler(snapshot: Weak<Mutex<SleepSnapshot>>) {
    loop {
        let Some(snapshot_state) = snapshot.upgrade() else {
            return;
        };
        let sampled = sample_sleep_blockers();
        if let Ok(mut current) = snapshot_state.lock() {
            *current = sampled;
        }
        drop(snapshot_state);
        for _ in 0..SLEEP_REFRESH_INTERVAL.as_secs() {
            thread::sleep(Duration::from_secs(1));
            if snapshot.strong_count() == 0 {
                return;
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn sample_sleep_blockers() -> SleepSnapshot {
    use std::process::Command;

    let output = Command::new("pmset").args(["-g", "assertions"]).output();
    let Some(output) = output.ok().filter(|output| output.status.success()) else {
        return unavailable_sleep();
    };
    let Ok(output) = String::from_utf8(output.stdout) else {
        return unavailable_sleep();
    };
    SleepSnapshot {
        sampled_at_ms: now_millis(),
        available: true,
        blockers: parse_pmset_assertions(&output),
    }
}

#[cfg(not(target_os = "macos"))]
fn sample_sleep_blockers() -> SleepSnapshot {
    unavailable_sleep()
}

#[cfg(target_os = "macos")]
fn parse_pmset_assertions(output: &str) -> Vec<SleepBlocker> {
    let mut blockers = Vec::<SleepBlocker>::new();
    for blocker in output.lines().filter_map(parse_pmset_assertion_line) {
        if let Some(existing) = blockers
            .iter_mut()
            .find(|existing| existing.pid == blocker.pid && existing.kind == blocker.kind)
        {
            if blocker.duration_seconds > existing.duration_seconds {
                existing.duration_seconds = blocker.duration_seconds;
            }
            if existing.reason.is_none() {
                existing.reason = blocker.reason;
            }
        } else {
            blockers.push(blocker);
        }
    }
    blockers.sort_by(|left, right| {
        right
            .duration_seconds
            .cmp(&left.duration_seconds)
            .then_with(|| left.process_name.cmp(&right.process_name))
    });
    blockers
}

#[cfg(target_os = "macos")]
fn parse_pmset_assertion_line(line: &str) -> Option<SleepBlocker> {
    let line = line.trim();
    let line = line.strip_prefix("pid ")?;
    let (owner, details) = line.split_once("):")?;
    let (pid, process_name) = owner.split_once('(')?;
    let pid = pid.trim().parse::<u32>().ok()?;
    let process_name = process_name.trim();
    if process_name.is_empty() {
        return None;
    }
    let details = details
        .trim()
        .split_once("] ")
        .map_or(details.trim(), |(_, remainder)| remainder.trim());
    let mut fields = details.split_whitespace();
    let duration = fields.next()?;
    let assertion = fields.next()?;
    let kind = sleep_blocker_kind(assertion)?;
    let reason = details
        .strip_prefix(duration)?
        .trim_start()
        .strip_prefix(assertion)?
        .trim_start()
        .strip_prefix("named:")
        .map(str::trim)
        .map(|reason| reason.trim_matches('"').trim())
        .filter(|reason| !reason.is_empty())
        .map(str::to_owned);
    Some(SleepBlocker {
        pid: Some(pid),
        process_name: process_name.to_owned(),
        reason,
        kind,
        duration_seconds: parse_assertion_duration(duration),
    })
}

#[cfg(target_os = "macos")]
fn sleep_blocker_kind(assertion: &str) -> Option<SleepBlockerKind> {
    let assertion = assertion.to_ascii_lowercase();
    if assertion.contains("display") {
        Some(SleepBlockerKind::Display)
    } else if assertion.contains("systemsleep") && !assertion.contains("idle") {
        Some(SleepBlockerKind::System)
    } else if assertion.contains("idle") || assertion.contains("noidlesleep") {
        Some(SleepBlockerKind::Idle)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn parse_assertion_duration(duration: &str) -> Option<u64> {
    let mut parts = duration.split(':');
    let hours = parts.next()?.parse::<u64>().ok()?;
    let minutes = parts.next()?.parse::<u64>().ok()?;
    let seconds = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() || minutes >= 60 || seconds >= 60 {
        return None;
    }
    Some(
        hours
            .saturating_mul(3_600)
            .saturating_add(minutes.saturating_mul(60))
            .saturating_add(seconds),
    )
}

fn unavailable_sleep() -> SleepSnapshot {
    SleepSnapshot {
        sampled_at_ms: now_millis(),
        available: false,
        blockers: Vec::new(),
    }
}

fn hottest_temperature(components: &Components) -> TemperatureSnapshot {
    let hottest = components
        .iter()
        .filter_map(|component| {
            let temperature = component.temperature()?;
            (temperature.is_finite() && (-20.0..=150.0).contains(&temperature)).then_some((
                temperature,
                component.label().to_owned(),
                component.critical().filter(|value| value.is_finite()),
            ))
        })
        .max_by(|left, right| left.0.total_cmp(&right.0));
    match hottest {
        Some((celsius, label, critical_celsius)) => TemperatureSnapshot {
            celsius: Some(celsius),
            component_label: Some(label),
            critical_celsius,
        },
        None => TemperatureSnapshot {
            celsius: None,
            component_label: None,
            critical_celsius: None,
        },
    }
}

#[cfg(target_os = "macos")]
fn sample_battery() -> BatterySnapshot {
    use std::process::Command;

    let output = Command::new("pmset").args(["-g", "batt"]).output();
    output
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|output| parse_pmset_battery(&output))
        .unwrap_or_else(unavailable_battery)
}

#[cfg(target_os = "macos")]
fn parse_pmset_battery(output: &str) -> Option<BatterySnapshot> {
    let lower = output.to_ascii_lowercase();
    let power_source = if lower.contains("ac power") {
        PowerSource::Ac
    } else if lower.contains("battery power") {
        PowerSource::Battery
    } else {
        PowerSource::Unknown
    };
    let battery_line = output.lines().find(|line| line.contains('%'))?;
    let percent_marker = battery_line.find('%')?;
    let percentage = battery_line[..percent_marker]
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .rfind(|part| !part.is_empty())?
        .parse::<f32>()
        .ok()?
        .clamp(0.0, 100.0);
    let status = battery_line[percent_marker + 1..].to_ascii_lowercase();
    let state = if status.contains("discharging") {
        BatteryState::Discharging
    } else if status.contains("not charging") {
        BatteryState::NotCharging
    } else if status.contains("charging") || status.contains("finishing charge") {
        BatteryState::Charging
    } else if status.contains("charged") {
        BatteryState::Full
    } else {
        BatteryState::Unknown
    };
    Some(BatterySnapshot {
        present: true,
        charge_percent: Some(percentage),
        state,
        time_remaining_minutes: parse_time_remaining(&status),
        power_source,
    })
}

#[cfg(target_os = "macos")]
fn parse_time_remaining(status: &str) -> Option<u64> {
    status
        .split(|character: char| character.is_whitespace() || character == ';')
        .find_map(|part| {
            let (hours, minutes) = part.split_once(':')?;
            let hours = hours.parse::<u64>().ok()?;
            let minutes = minutes.parse::<u64>().ok()?;
            (minutes < 60).then_some(hours.saturating_mul(60).saturating_add(minutes))
        })
}

#[cfg(target_os = "linux")]
fn sample_battery() -> BatterySnapshot {
    use std::fs;
    use std::path::{Path, PathBuf};

    let Ok(entries) = fs::read_dir("/sys/class/power_supply") else {
        return unavailable_battery();
    };
    let battery = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            read_trimmed(path.join("type"))
                .is_some_and(|value| value.eq_ignore_ascii_case("battery"))
        });
    let Some(battery) = battery else {
        return unavailable_battery();
    };
    let charge_percent = read_trimmed(battery.join("capacity"))
        .and_then(|value| value.parse::<f32>().ok())
        .map(|value| value.clamp(0.0, 100.0));
    let status = read_trimmed(battery.join("status")).unwrap_or_default();
    let state = match status.to_ascii_lowercase().as_str() {
        "charging" => BatteryState::Charging,
        "discharging" => BatteryState::Discharging,
        "full" => BatteryState::Full,
        "not charging" => BatteryState::NotCharging,
        _ => BatteryState::Unknown,
    };
    let power_source = ac_power_connected(Path::new("/sys/class/power_supply")).map_or(
        PowerSource::Unknown,
        |connected| {
            if connected {
                PowerSource::Ac
            } else {
                PowerSource::Battery
            }
        },
    );
    let snapshot = BatterySnapshot {
        present: true,
        charge_percent,
        state,
        time_remaining_minutes: linux_time_remaining(&battery, state),
        power_source,
    };

    fn read_trimmed(path: PathBuf) -> Option<String> {
        fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_owned())
    }

    fn read_number(path: PathBuf) -> Option<f64> {
        read_trimmed(path)?.parse().ok()
    }

    fn linux_time_remaining(path: &Path, state: BatteryState) -> Option<u64> {
        let now = read_number(path.join("energy_now"))
            .or_else(|| read_number(path.join("charge_now")))?;
        let full = read_number(path.join("energy_full"))
            .or_else(|| read_number(path.join("charge_full")))?;
        let rate = read_number(path.join("power_now"))
            .or_else(|| read_number(path.join("current_now")))?;
        if rate <= 0.0 {
            return None;
        }
        let remaining = match state {
            BatteryState::Charging => (full - now).max(0.0),
            BatteryState::Discharging => now,
            _ => return None,
        };
        Some((remaining / rate * 60.0).round().max(0.0) as u64)
    }

    fn ac_power_connected(root: &Path) -> Option<bool> {
        fs::read_dir(root)
            .ok()?
            .filter_map(Result::ok)
            .find_map(|entry| {
                let path = entry.path();
                let kind = read_trimmed(path.join("type"))?;
                if !kind.eq_ignore_ascii_case("mains") && !kind.eq_ignore_ascii_case("usb") {
                    return None;
                }
                read_trimmed(path.join("online")).map(|value| value == "1")
            })
    }

    snapshot
}

#[cfg(windows)]
fn sample_battery() -> BatterySnapshot {
    use std::mem::MaybeUninit;
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = MaybeUninit::<SYSTEM_POWER_STATUS>::zeroed();
    if unsafe { GetSystemPowerStatus(status.as_mut_ptr()) } == 0 {
        return unavailable_battery();
    }
    let status = unsafe { status.assume_init() };
    let present = status.BatteryFlag != 128;
    let state = if !present {
        BatteryState::Unknown
    } else if status.BatteryFlag & 8 != 0 {
        BatteryState::Charging
    } else if status.BatteryLifePercent >= 100 {
        BatteryState::Full
    } else if status.ACLineStatus == 0 {
        BatteryState::Discharging
    } else {
        BatteryState::NotCharging
    };
    BatterySnapshot {
        present,
        charge_percent: (present && status.BatteryLifePercent <= 100)
            .then(|| f32::from(status.BatteryLifePercent)),
        state,
        time_remaining_minutes: (present && status.BatteryLifeTime != u32::MAX)
            .then(|| u64::from(status.BatteryLifeTime) / 60),
        power_source: match status.ACLineStatus {
            0 => PowerSource::Battery,
            1 => PowerSource::Ac,
            _ => PowerSource::Unknown,
        },
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn sample_battery() -> BatterySnapshot {
    unavailable_battery()
}

fn unavailable_battery() -> BatterySnapshot {
    BatterySnapshot {
        present: false,
        charge_percent: None,
        state: BatteryState::Unknown,
        time_remaining_minutes: None,
        power_source: PowerSource::Unknown,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::{
        BatteryState, PowerSource, SleepBlockerKind, parse_pmset_assertions, parse_pmset_battery,
    };

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_battery_status() {
        let snapshot = parse_pmset_battery(
            "Now drawing from 'Battery Power'\n -InternalBattery-0 84%; discharging; 3:12 remaining present: true",
        )
        .expect("battery should parse");
        assert_eq!(snapshot.charge_percent, Some(84.0));
        assert_eq!(snapshot.state, BatteryState::Discharging);
        assert_eq!(snapshot.time_remaining_minutes, Some(192));
        assert_eq!(snapshot.power_source, PowerSource::Battery);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_charged_status_without_time() {
        let snapshot = parse_pmset_battery(
            "Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged; 0:00 remaining present: true",
        )
        .expect("battery should parse");
        assert_eq!(snapshot.state, BatteryState::Full);
        assert_eq!(snapshot.power_source, PowerSource::Ac);
        assert_eq!(snapshot.time_remaining_minutes, Some(0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_only_sleep_related_macos_assertions() {
        let blockers = parse_pmset_assertions(
            r#"Assertion status system-wide:
Listed by owning process:
   pid 72641(ChatGPT): [0x01] 29:07:38 NoIdleSleepAssertion named: "Electron"
   pid 72641(ChatGPT): [0x02] 00:05:12 PreventUserIdleDisplaySleep named: "Video playback"
   pid 365(mds): [0x03] 39:40:28 BackgroundTask named: "com.apple.metadata.mds.power"
   pid 88(powerd): [0x04] 00:01:09 PreventSystemSleep named: "Maintenance"
"#,
        );

        assert_eq!(blockers.len(), 3);
        assert_eq!(blockers[0].process_name, "ChatGPT");
        assert_eq!(blockers[0].duration_seconds, Some(104_858));
        assert_eq!(blockers[0].kind, SleepBlockerKind::Idle);
        assert_eq!(blockers[1].kind, SleepBlockerKind::Display);
        assert_eq!(blockers[2].process_name, "powerd");
        assert_eq!(blockers[2].kind, SleepBlockerKind::System);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn merges_duplicate_assertions_from_the_same_process() {
        let blockers = parse_pmset_assertions(
            r#"pid 42(Video): [0x01] 00:01:00 NoIdleSleepAssertion named: "First"
pid 42(Video): [0x02] 00:12:00 NoIdleSleepAssertion named: "Second""#,
        );

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].duration_seconds, Some(720));
        assert_eq!(blockers[0].reason.as_deref(), Some("First"));
    }
}
