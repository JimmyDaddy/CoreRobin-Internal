use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::Components;

#[cfg(target_os = "macos")]
use crate::bounded_command;
use crate::models::{
    BatterySnapshot, BatteryState, PowerSource, SensorsSnapshot, SleepSnapshot, TemperatureSnapshot,
};
#[cfg(target_os = "macos")]
use crate::models::{SleepBlocker, SleepBlockerKind};

const SENSOR_REFRESH_INTERVAL: Duration = Duration::from_secs(10);
const SLEEP_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const BATTERY_DETAILS_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
#[cfg(target_os = "macos")]
const SENSOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "macos")]
const SENSOR_COMMAND_OUTPUT_LIMIT: usize = 2 * 1_024 * 1_024;

#[derive(Clone, Copy, Debug, Default)]
struct BatteryDetails {
    health_percent: Option<f32>,
    cycle_count: Option<u64>,
}

pub struct SensorSampler {
    components: Components,
    last_refresh: Instant,
    snapshot: SensorsSnapshot,
    sleep: Arc<Mutex<SleepSnapshot>>,
    battery_details: BatteryDetails,
    last_battery_details_refresh: Instant,
}

impl SensorSampler {
    pub fn new() -> Self {
        let components = Components::new_with_refreshed_list();
        let sleep = start_sleep_sampler();
        let mut battery = sample_battery();
        let battery_details = if battery_needs_fallback_details(&battery) {
            sample_battery_details().unwrap_or_default()
        } else {
            BatteryDetails::default()
        };
        apply_battery_details(&mut battery, battery_details);
        let snapshot = build_sensors_snapshot(&components, &sleep, battery);
        Self {
            components,
            last_refresh: Instant::now(),
            snapshot,
            sleep,
            battery_details,
            last_battery_details_refresh: Instant::now(),
        }
    }

    pub fn sample(&mut self) -> SensorsSnapshot {
        if self.last_refresh.elapsed() >= SENSOR_REFRESH_INTERVAL {
            self.components.refresh(true);
            let mut battery = sample_battery();
            if battery_needs_fallback_details(&battery)
                && self.last_battery_details_refresh.elapsed() >= BATTERY_DETAILS_REFRESH_INTERVAL
            {
                if let Some(details) = sample_battery_details() {
                    self.battery_details.health_percent = details
                        .health_percent
                        .or(self.battery_details.health_percent);
                    self.battery_details.cycle_count =
                        details.cycle_count.or(self.battery_details.cycle_count);
                }
                self.last_battery_details_refresh = Instant::now();
            }
            apply_battery_details(&mut battery, self.battery_details);
            self.snapshot = build_sensors_snapshot(&self.components, &self.sleep, battery);
            self.last_refresh = Instant::now();
        }
        self.snapshot.sleep = cached_sleep_snapshot(&self.sleep);
        self.snapshot.clone()
    }
}

fn battery_needs_fallback_details(battery: &BatterySnapshot) -> bool {
    battery.present && (battery.health_percent.is_none() || battery.cycle_count.is_none())
}

fn apply_battery_details(battery: &mut BatterySnapshot, battery_details: BatteryDetails) {
    if battery.present {
        battery.health_percent = battery.health_percent.or(battery_details.health_percent);
        battery.cycle_count = battery.cycle_count.or(battery_details.cycle_count);
    }
}

fn build_sensors_snapshot(
    components: &Components,
    sleep: &Arc<Mutex<SleepSnapshot>>,
    battery: BatterySnapshot,
) -> SensorsSnapshot {
    SensorsSnapshot {
        sampled_at_ms: now_millis(),
        temperature: hottest_temperature(components),
        battery,
        sleep: cached_sleep_snapshot(sleep),
    }
}

#[cfg(target_os = "macos")]
fn sample_battery_details() -> Option<BatteryDetails> {
    use std::process::Command;

    let mut system_profiler = Command::new("system_profiler");
    system_profiler.args(["SPPowerDataType", "-json"]);
    let mut details = run_system_profiler_battery_details(&mut system_profiler)?;

    // An x86_64 process running through Rosetta omits maximum-capacity data from
    // system_profiler on Apple Silicon. Retry the system tool natively so the
    // Intel package still reports battery health when it is used as a fallback.
    if details.health_percent.is_none() {
        let mut native_system_profiler = Command::new("/usr/bin/arch");
        native_system_profiler.args([
            "-arm64",
            "/usr/sbin/system_profiler",
            "SPPowerDataType",
            "-json",
        ]);
        if let Some(native_details) =
            run_system_profiler_battery_details(&mut native_system_profiler)
        {
            details = merge_battery_details(details, native_details);
        }
    }

    Some(details)
}

#[cfg(target_os = "macos")]
fn run_system_profiler_battery_details(
    command: &mut std::process::Command,
) -> Option<BatteryDetails> {
    let output = bounded_command::output_with_circuit(
        "sensor.system-profiler-battery",
        command,
        SENSOR_COMMAND_TIMEOUT,
        SENSOR_COMMAND_OUTPUT_LIMIT,
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let output = String::from_utf8(output.stdout).ok()?;
    parse_system_profiler_battery_details(&output)
}

#[cfg(not(target_os = "macos"))]
fn sample_battery_details() -> Option<BatteryDetails> {
    None
}

#[cfg(target_os = "macos")]
fn parse_system_profiler_battery_details(output: &str) -> Option<BatteryDetails> {
    let root: serde_json::Value = serde_json::from_str(output).ok()?;
    let health = root
        .get("SPPowerDataType")?
        .as_array()?
        .iter()
        .find_map(|item| item.get("sppower_battery_health_info"))?;
    let health_percent = health
        .get("sppower_battery_health_maximum_capacity")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|value| value.trim().trim_end_matches('%').parse::<f32>().ok())
                .or_else(|| value.as_f64().map(|value| value as f32))
        })
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0));
    let cycle_count = health.get("sppower_battery_cycle_count").and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    });

    (health_percent.is_some() || cycle_count.is_some()).then_some(BatteryDetails {
        health_percent,
        cycle_count,
    })
}

#[cfg(target_os = "macos")]
fn merge_battery_details(preferred: BatteryDetails, fallback: BatteryDetails) -> BatteryDetails {
    BatteryDetails {
        health_percent: preferred.health_percent.or(fallback.health_percent),
        cycle_count: preferred.cycle_count.or(fallback.cycle_count),
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
        .name("core-robin-sleep-assertions".to_owned())
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

    let output = bounded_command::output_with_circuit(
        "sensor.pmset-assertions",
        Command::new("pmset").args(["-g", "assertions"]),
        SENSOR_COMMAND_TIMEOUT,
        SENSOR_COMMAND_OUTPUT_LIMIT,
    );
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
#[derive(Clone, Copy, Debug, Default)]
struct IokitBatteryFields {
    current_capacity: Option<i64>,
    max_capacity: Option<i64>,
    nominal_charge_capacity: Option<i64>,
    apple_raw_max_capacity: Option<i64>,
    design_capacity: Option<i64>,
    cycle_count: Option<i64>,
    external_connected: Option<bool>,
    is_charging: Option<bool>,
    fully_charged: Option<bool>,
    time_remaining: Option<i64>,
    avg_time_to_empty: Option<i64>,
    avg_time_to_full: Option<i64>,
}

#[cfg(target_os = "macos")]
enum IokitBatteryProbe {
    Present(BatterySnapshot),
    Absent,
    Unavailable,
}

#[cfg(target_os = "macos")]
fn sample_battery() -> BatterySnapshot {
    match sample_battery_iokit() {
        IokitBatteryProbe::Present(snapshot) => snapshot,
        IokitBatteryProbe::Absent => unavailable_battery(),
        IokitBatteryProbe::Unavailable => sample_battery_pmset(),
    }
}

#[cfg(target_os = "macos")]
fn sample_battery_pmset() -> BatterySnapshot {
    use std::process::Command;

    let output = bounded_command::output_with_circuit(
        "sensor.pmset-battery",
        Command::new("pmset").args(["-g", "batt"]),
        SENSOR_COMMAND_TIMEOUT,
        SENSOR_COMMAND_OUTPUT_LIMIT,
    );
    output
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|output| parse_pmset_battery(&output))
        .unwrap_or_else(unavailable_battery)
}

#[cfg(target_os = "macos")]
fn sample_battery_iokit() -> IokitBatteryProbe {
    use std::ffi::{CStr, c_char, c_void};
    use std::ptr;

    const K_IO_MAIN_PORT_DEFAULT: u32 = 0;
    const KERN_SUCCESS: i32 = 0;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_SINT64_TYPE: isize = 4;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperties(
            entry: u32,
            properties: *mut *mut c_void,
            allocator: *const c_void,
            options: u32,
        ) -> i32;
        fn IOObjectRelease(object: u32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFDictionaryGetValue(the_dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(boolean: *const c_void) -> u8;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: *const c_void, the_type: isize, value_ptr: *mut c_void) -> u8;
    }

    struct IoObjectGuard(u32);
    impl Drop for IoObjectGuard {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    let _ = IOObjectRelease(self.0);
                }
            }
        }
    }

    struct CfObjectGuard(*const c_void);
    impl Drop for CfObjectGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CFRelease(self.0);
                }
            }
        }
    }

    fn dict_get_value(dict: *const c_void, key: &CStr) -> *const c_void {
        let cf_key = unsafe {
            CFStringCreateWithCString(ptr::null(), key.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if cf_key.is_null() {
            return ptr::null();
        }
        let _key_guard = CfObjectGuard(cf_key);
        unsafe { CFDictionaryGetValue(dict, cf_key) }
    }

    fn dict_get_i64(dict: *const c_void, key: &CStr) -> Option<i64> {
        let value = dict_get_value(dict, key);
        if value.is_null() {
            return None;
        }
        unsafe {
            if CFGetTypeID(value) != CFNumberGetTypeID() {
                return None;
            }
            let mut out: i64 = 0;
            let ok = CFNumberGetValue(
                value,
                K_CF_NUMBER_SINT64_TYPE,
                (&mut out as *mut i64).cast::<c_void>(),
            );
            (ok != 0).then_some(out)
        }
    }

    fn dict_get_bool(dict: *const c_void, key: &CStr) -> Option<bool> {
        let value = dict_get_value(dict, key);
        if value.is_null() {
            return None;
        }
        unsafe {
            if CFGetTypeID(value) != CFBooleanGetTypeID() {
                return None;
            }
            Some(CFBooleanGetValue(value) != 0)
        }
    }

    let matching = unsafe { IOServiceMatching(c"AppleSmartBattery".as_ptr()) };
    if matching.is_null() {
        return IokitBatteryProbe::Unavailable;
    }
    // IOServiceGetMatchingService takes ownership of `matching`.
    let service = unsafe { IOServiceGetMatchingService(K_IO_MAIN_PORT_DEFAULT, matching) };
    if service == 0 {
        return IokitBatteryProbe::Absent;
    }
    let _service_guard = IoObjectGuard(service);

    let mut properties_ptr: *mut c_void = ptr::null_mut();
    let status =
        unsafe { IORegistryEntryCreateCFProperties(service, &mut properties_ptr, ptr::null(), 0) };
    if status != KERN_SUCCESS || properties_ptr.is_null() {
        return IokitBatteryProbe::Unavailable;
    }
    let _properties_guard = CfObjectGuard(properties_ptr.cast_const());
    let dict = properties_ptr.cast_const();

    let fields = IokitBatteryFields {
        current_capacity: dict_get_i64(dict, c"CurrentCapacity"),
        max_capacity: dict_get_i64(dict, c"MaxCapacity"),
        nominal_charge_capacity: dict_get_i64(dict, c"NominalChargeCapacity"),
        apple_raw_max_capacity: dict_get_i64(dict, c"AppleRawMaxCapacity"),
        design_capacity: dict_get_i64(dict, c"DesignCapacity"),
        cycle_count: dict_get_i64(dict, c"CycleCount"),
        external_connected: dict_get_bool(dict, c"ExternalConnected"),
        is_charging: dict_get_bool(dict, c"IsCharging"),
        fully_charged: dict_get_bool(dict, c"FullyCharged"),
        time_remaining: dict_get_i64(dict, c"TimeRemaining"),
        avg_time_to_empty: dict_get_i64(dict, c"AvgTimeToEmpty"),
        avg_time_to_full: dict_get_i64(dict, c"AvgTimeToFull"),
    };

    match battery_snapshot_from_iokit_fields(fields) {
        Some(snapshot) => IokitBatteryProbe::Present(snapshot),
        None => IokitBatteryProbe::Unavailable,
    }
}

#[cfg(target_os = "macos")]
fn battery_snapshot_from_iokit_fields(fields: IokitBatteryFields) -> Option<BatterySnapshot> {
    let charge_percent = match (fields.current_capacity, fields.max_capacity) {
        (Some(current), Some(max)) if current >= 0 && max > 0 => {
            Some((((current as f64) / (max as f64)) * 100.0).clamp(0.0, 100.0) as f32)
        }
        _ => return None,
    };

    let health_percent = iokit_battery_health(fields);
    let cycle_count = fields
        .cycle_count
        .and_then(|value| u64::try_from(value).ok());
    let power_source = match fields.external_connected {
        Some(true) => PowerSource::Ac,
        Some(false) => PowerSource::Battery,
        None => PowerSource::Unknown,
    };
    let state = if fields.is_charging == Some(true) {
        BatteryState::Charging
    } else if fields.fully_charged == Some(true)
        || (fields.external_connected == Some(true)
            && charge_percent.is_some_and(|percent| percent >= 99.5))
    {
        BatteryState::Full
    } else if fields.external_connected == Some(false) {
        BatteryState::Discharging
    } else if fields.external_connected == Some(true) {
        BatteryState::NotCharging
    } else {
        BatteryState::Unknown
    };
    let time_remaining_minutes = match state {
        BatteryState::Discharging => sanitize_iokit_minutes(fields.avg_time_to_empty)
            .or_else(|| sanitize_iokit_minutes(fields.time_remaining)),
        BatteryState::Charging => sanitize_iokit_minutes(fields.avg_time_to_full)
            .or_else(|| sanitize_iokit_minutes(fields.time_remaining)),
        _ => None,
    };

    Some(BatterySnapshot {
        present: true,
        charge_percent,
        health_percent,
        cycle_count,
        state,
        time_remaining_minutes,
        power_source,
    })
}

#[cfg(target_os = "macos")]
fn iokit_battery_health(fields: IokitBatteryFields) -> Option<f32> {
    let design = fields.design_capacity.filter(|&value| value > 0)?;
    let full = fields
        .nominal_charge_capacity
        .filter(|&value| value > 0)
        .or_else(|| fields.apple_raw_max_capacity.filter(|&value| value > 0))
        .or_else(|| fields.max_capacity.filter(|&value| value > 100))?;
    let percent = (((full as f64) / (design as f64)) * 100.0)
        .round()
        .clamp(0.0, 100.0) as f32;
    percent.is_finite().then_some(percent)
}

#[cfg(target_os = "macos")]
fn sanitize_iokit_minutes(value: Option<i64>) -> Option<u64> {
    let value = value?;
    // IOKit uses 65535 (0xFFFF) as the sentinel for "unknown / calculating".
    (0..65_535).contains(&value).then_some(value as u64)
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
        health_percent: None,
        cycle_count: None,
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
        health_percent: linux_battery_health(&battery),
        cycle_count: read_trimmed(battery.join("cycle_count"))
            .and_then(|value| value.parse::<u64>().ok()),
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

    fn linux_battery_health(path: &Path) -> Option<f32> {
        fn ratio(full: Option<f64>, design: Option<f64>) -> Option<f32> {
            let (full, design) = (full?, design?);
            (full.is_finite() && design.is_finite() && full >= 0.0 && design > 0.0)
                .then(|| ((full / design) * 100.0).clamp(0.0, 100.0) as f32)
        }

        ratio(
            read_number(path.join("energy_full")),
            read_number(path.join("energy_full_design")),
        )
        .or_else(|| {
            ratio(
                read_number(path.join("charge_full")),
                read_number(path.join("charge_full_design")),
            )
        })
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
        health_percent: None,
        cycle_count: None,
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
        health_percent: None,
        cycle_count: None,
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
        BatteryDetails, BatteryState, IokitBatteryFields, IokitBatteryProbe, PowerSource,
        SleepBlockerKind, battery_snapshot_from_iokit_fields, merge_battery_details,
        parse_pmset_assertions, parse_pmset_battery, parse_system_profiler_battery_details,
        sample_battery_iokit,
    };

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_iokit_battery_fields_accurately() {
        let apple_silicon = battery_snapshot_from_iokit_fields(IokitBatteryFields {
            current_capacity: Some(100),
            max_capacity: Some(100),
            nominal_charge_capacity: Some(5362),
            apple_raw_max_capacity: Some(5210),
            design_capacity: Some(6249),
            cycle_count: Some(194),
            external_connected: Some(true),
            is_charging: Some(false),
            fully_charged: Some(true),
            time_remaining: Some(65535),
            avg_time_to_empty: Some(65535),
            avg_time_to_full: Some(65535),
        })
        .expect("apple silicon fields should parse");
        assert!(apple_silicon.present);
        assert_eq!(apple_silicon.charge_percent, Some(100.0));
        assert_eq!(apple_silicon.health_percent, Some(86.0));
        assert_eq!(apple_silicon.cycle_count, Some(194));
        assert_eq!(apple_silicon.state, BatteryState::Full);
        assert_eq!(apple_silicon.power_source, PowerSource::Ac);
        assert_eq!(apple_silicon.time_remaining_minutes, None);

        let discharging = battery_snapshot_from_iokit_fields(IokitBatteryFields {
            current_capacity: Some(4200),
            max_capacity: Some(5000),
            nominal_charge_capacity: None,
            apple_raw_max_capacity: Some(4800),
            design_capacity: Some(5200),
            cycle_count: Some(88),
            external_connected: Some(false),
            is_charging: Some(false),
            fully_charged: Some(false),
            time_remaining: Some(215),
            avg_time_to_empty: Some(192),
            avg_time_to_full: Some(65535),
        })
        .expect("discharging fields should parse");
        assert_eq!(discharging.charge_percent, Some(84.0));
        assert_eq!(discharging.health_percent, Some(92.0));
        assert_eq!(discharging.state, BatteryState::Discharging);
        assert_eq!(discharging.power_source, PowerSource::Battery);
        assert_eq!(discharging.time_remaining_minutes, Some(192));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn probes_macos_iokit_battery_without_spawning_subprocesses() {
        let started = std::time::Instant::now();
        let probe = sample_battery_iokit();
        let elapsed = started.elapsed();
        match probe {
            IokitBatteryProbe::Present(snapshot) => {
                assert!(snapshot.present);
                assert!(snapshot.charge_percent.is_some());
                assert!(snapshot.health_percent.is_some());
                assert!(snapshot.cycle_count.is_some());
            }
            IokitBatteryProbe::Absent => {}
            IokitBatteryProbe::Unavailable => panic!("IOKit battery probe unexpectedly failed"),
        }
        assert!(
            elapsed < std::time::Duration::from_millis(200),
            "IOKit battery probe took unexpectedly long: {elapsed:?}"
        );
    }

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
    fn parses_macos_battery_health_and_cycle_count() {
        let details = parse_system_profiler_battery_details(
            r#"{
              "SPPowerDataType": [{
                "sppower_battery_health_info": {
                  "sppower_battery_cycle_count": 173,
                  "sppower_battery_health_maximum_capacity": "94%"
                }
              }]
            }"#,
        )
        .expect("battery details should parse");

        assert_eq!(details.health_percent, Some(94.0));
        assert_eq!(details.cycle_count, Some(173));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fills_rosetta_battery_health_without_replacing_existing_cycle_count() {
        let merged = merge_battery_details(
            BatteryDetails {
                health_percent: None,
                cycle_count: Some(173),
            },
            BatteryDetails {
                health_percent: Some(94.0),
                cycle_count: Some(999),
            },
        );

        assert_eq!(merged.health_percent, Some(94.0));
        assert_eq!(merged.cycle_count, Some(173));
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
