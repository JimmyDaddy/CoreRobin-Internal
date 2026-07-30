use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::models::{MemorySnapshot, ProcessRow, SystemSnapshot, SystemSummary};

pub const SUPERVISOR_NOTIFICATION_EVENT: &str = "core-robin:supervisor-notification";

const ALERT_BREACH_MS: u64 = 10_000;
const ALERT_RECOVERY_MS: u64 = 15_000;
const ALERT_COOLDOWN_MS: u64 = 60_000;
const ALERT_RECOVERY_HYSTERESIS: f32 = 5.0;
const APPLICATION_WATCH_COOLDOWN_MS: u64 = 10 * 60 * 1_000;
const MAX_RESOURCE_NOTIFICATIONS_PER_24_HOURS: usize = 4;
const MEBIBYTE: f32 = 1_048_576.0;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorResource {
    Cpu,
    Memory,
    Volume,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorWatchMetric {
    Cpu,
    Memory,
    Disk,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorWatchRule {
    pub id: String,
    pub application_name: String,
    pub application_id: Option<String>,
    pub metric: SupervisorWatchMetric,
    pub threshold: f32,
    pub duration_seconds: u64,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorNotificationCopy {
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorResourceCopy {
    pub triggered: SupervisorNotificationCopy,
    pub recovered: SupervisorNotificationCopy,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorWatchCopy {
    pub triggered: SupervisorNotificationCopy,
    pub recovered: SupervisorNotificationCopy,
    pub cpu_metric: String,
    pub memory_metric: String,
    pub disk_metric: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorNotificationCopies {
    pub cpu: SupervisorResourceCopy,
    pub memory: SupervisorResourceCopy,
    pub volume: SupervisorResourceCopy,
    pub watch: SupervisorWatchCopy,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSupervisorConfig {
    pub notifications_enabled: bool,
    pub notification_permission_granted: bool,
    pub usage_thresholds: [f32; 3],
    pub muted_resources: Vec<SupervisorResource>,
    pub application_watch_rules: Vec<SupervisorWatchRule>,
    pub copies: SupervisorNotificationCopies,
}

impl Default for BackgroundSupervisorConfig {
    fn default() -> Self {
        Self {
            notifications_enabled: false,
            notification_permission_granted: false,
            usage_thresholds: [35.0, 65.0, 85.0],
            muted_resources: Vec::new(),
            application_watch_rules: Vec::new(),
            copies: SupervisorNotificationCopies::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorNotificationDelivery {
    kind: &'static str,
    status: &'static str,
    attempted_at_ms: u64,
}

#[derive(Clone, Debug, Default)]
struct ResourceTracker {
    breach_since_ms: Option<u64>,
    recovery_since_ms: Option<u64>,
    active_since_ms: Option<u64>,
    active_critical: bool,
    cooldown_until_ms: u64,
}

#[derive(Clone, Debug, Default)]
struct WatchTracker {
    started_at_ms: Option<u64>,
    active: bool,
    last_notified_at_ms: Option<u64>,
}

#[derive(Default)]
struct SupervisorRuntime {
    resources: HashMap<SupervisorResource, ResourceTracker>,
    watches: HashMap<String, WatchTracker>,
    resource_notifications_at_ms: Vec<u64>,
}

#[derive(Default)]
pub struct BackgroundSupervisor {
    config: Mutex<BackgroundSupervisorConfig>,
    runtime: Mutex<SupervisorRuntime>,
}

impl BackgroundSupervisor {
    pub fn configure(&self, mut config: BackgroundSupervisorConfig) {
        config.application_watch_rules.truncate(50);
        if let Ok(mut current) = self.config.lock() {
            *current = config;
        }
    }

    pub fn observe_summary(&self, app: &AppHandle, summary: &SystemSummary) {
        self.observe_resources(app, summary);
    }

    pub fn observe_snapshot(&self, app: &AppHandle, snapshot: &SystemSnapshot) {
        self.observe_resources(app, &summary_from_snapshot(snapshot));
        self.observe_application_rules(app, snapshot);
    }

    fn observe_resources(&self, app: &AppHandle, summary: &SystemSummary) {
        let Ok(config) = self.config.lock().map(|config| config.clone()) else {
            return;
        };
        let highest_volume = summary
            .disk
            .volumes
            .iter()
            .filter(|volume| volume.total_bytes > 0)
            .map(|volume| {
                volume.total_bytes.saturating_sub(volume.available_bytes) as f32
                    / volume.total_bytes as f32
                    * 100.0
            })
            .reduce(f32::max);
        let samples = [
            (
                SupervisorResource::Cpu,
                summary.cpu.usage_percent,
                config.usage_thresholds[1],
                config.usage_thresholds[2],
            ),
            (
                SupervisorResource::Memory,
                Some(memory_pressure_percent(&summary.memory)),
                90.0,
                95.0,
            ),
            (SupervisorResource::Volume, highest_volume, 85.0, 95.0),
        ];
        for (resource, value, alert_threshold, critical_threshold) in samples {
            let Some(value) = value.filter(|value| value.is_finite() && *value >= 0.0) else {
                continue;
            };
            self.evaluate_resource(
                app,
                &config,
                resource,
                value.min(100.0),
                alert_threshold,
                critical_threshold,
                summary.sampled_at_ms,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn evaluate_resource(
        &self,
        app: &AppHandle,
        config: &BackgroundSupervisorConfig,
        resource: SupervisorResource,
        value: f32,
        alert_threshold: f32,
        critical_threshold: f32,
        sampled_at_ms: u64,
    ) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        let tracker = runtime.resources.entry(resource).or_default();
        let mut event = None;
        if value >= alert_threshold {
            tracker.recovery_since_ms = None;
            if tracker.active_since_ms.is_some() {
                tracker.active_critical |= value >= critical_threshold;
            } else {
                let breach_since = *tracker.breach_since_ms.get_or_insert(sampled_at_ms);
                if sampled_at_ms.saturating_sub(breach_since) >= ALERT_BREACH_MS
                    && sampled_at_ms >= tracker.cooldown_until_ms
                {
                    tracker.active_since_ms = Some(breach_since);
                    tracker.active_critical = value >= critical_threshold;
                    event = Some(("triggered", tracker.active_critical));
                }
            }
        } else if value < (alert_threshold - ALERT_RECOVERY_HYSTERESIS).max(0.0) {
            tracker.breach_since_ms = None;
            if tracker.active_since_ms.is_some() {
                let recovery_since = *tracker.recovery_since_ms.get_or_insert(sampled_at_ms);
                if sampled_at_ms.saturating_sub(recovery_since) >= ALERT_RECOVERY_MS {
                    event = Some(("recovered", tracker.active_critical));
                    tracker.active_since_ms = None;
                    tracker.active_critical = false;
                    tracker.recovery_since_ms = None;
                    tracker.cooldown_until_ms = sampled_at_ms.saturating_add(ALERT_COOLDOWN_MS);
                }
            }
        } else {
            tracker.breach_since_ms = None;
            tracker.recovery_since_ms = None;
        }
        let Some((kind, critical)) = event else {
            return;
        };
        if !config.notifications_enabled
            || !config.notification_permission_granted
            || config.muted_resources.contains(&resource)
            || resource == SupervisorResource::Cpu && !critical
        {
            return;
        }
        runtime
            .resource_notifications_at_ms
            .retain(|timestamp| sampled_at_ms.saturating_sub(*timestamp) <= 24 * 60 * 60 * 1_000);
        if runtime.resource_notifications_at_ms.len() >= MAX_RESOURCE_NOTIFICATIONS_PER_24_HOURS {
            return;
        }
        runtime.resource_notifications_at_ms.push(sampled_at_ms);
        drop(runtime);
        let copies = resource_copy(&config.copies, resource);
        let copy = if kind == "triggered" {
            &copies.triggered
        } else {
            &copies.recovered
        };
        deliver_notification(
            app,
            "resource",
            copy,
            Some(("coreRobinResource", resource_name(resource))),
        );
    }

    fn observe_application_rules(&self, app: &AppHandle, snapshot: &SystemSnapshot) {
        let Ok(config) = self.config.lock().map(|config| config.clone()) else {
            return;
        };
        let applications = aggregate_applications(&snapshot.processes);
        let mut runtime = match self.runtime.lock() {
            Ok(runtime) => runtime,
            Err(_) => return,
        };
        let rule_ids = config
            .application_watch_rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        runtime
            .watches
            .retain(|id, _| rule_ids.contains(id.as_str()));
        let mut notifications = Vec::new();
        for rule in &config.application_watch_rules {
            let tracker = runtime.watches.entry(rule.id.clone()).or_default();
            if !rule.enabled {
                tracker.started_at_ms = None;
                tracker.active = false;
                continue;
            }
            let application = applications.iter().find(|application| {
                rule.application_id
                    .as_deref()
                    .is_some_and(|id| id == application.application_id)
                    || application
                        .name
                        .eq_ignore_ascii_case(&rule.application_name)
            });
            let value = application
                .map(|application| application.metric(rule.metric))
                .unwrap_or(0.0);
            if application.is_none() || value < rule.threshold {
                if tracker.active {
                    notifications.push(("recovered", rule.clone(), application.cloned(), value));
                }
                tracker.started_at_ms = None;
                tracker.active = false;
                continue;
            }
            let started_at = *tracker.started_at_ms.get_or_insert(snapshot.sampled_at_ms);
            let sustained = snapshot.sampled_at_ms.saturating_sub(started_at)
                >= rule.duration_seconds.saturating_mul(1_000);
            let cooldown_ready = tracker.last_notified_at_ms.is_none_or(|last| {
                snapshot.sampled_at_ms.saturating_sub(last) >= APPLICATION_WATCH_COOLDOWN_MS
            });
            if sustained && !tracker.active && cooldown_ready {
                tracker.last_notified_at_ms = Some(snapshot.sampled_at_ms);
                notifications.push(("triggered", rule.clone(), application.cloned(), value));
            }
            tracker.active = sustained;
        }
        drop(runtime);
        if !config.notifications_enabled || !config.notification_permission_granted {
            return;
        }
        for (kind, rule, application, value) in notifications {
            let application_name = application
                .as_ref()
                .map(|application| application.name.as_str())
                .unwrap_or(rule.application_name.as_str());
            let metric = watch_metric_copy(&config.copies.watch, rule.metric, value);
            let template = if kind == "triggered" {
                &config.copies.watch.triggered
            } else {
                &config.copies.watch.recovered
            };
            let copy = SupervisorNotificationCopy {
                title: render_template(
                    &template.title,
                    application_name,
                    &metric,
                    rule.duration_seconds,
                ),
                body: render_template(
                    &template.body,
                    application_name,
                    &metric,
                    rule.duration_seconds,
                ),
            };
            deliver_notification(
                app,
                "watch",
                &copy,
                Some(("coreRobinApplicationName", application_name)),
            );
        }
    }
}

#[derive(Clone, Debug)]
struct ApplicationAggregate {
    application_id: String,
    name: String,
    cpu_percent: f32,
    memory_bytes: u64,
    disk_bytes_per_second: u64,
}

impl ApplicationAggregate {
    fn metric(&self, metric: SupervisorWatchMetric) -> f32 {
        match metric {
            SupervisorWatchMetric::Cpu => self.cpu_percent,
            SupervisorWatchMetric::Memory => self.memory_bytes as f32 / MEBIBYTE,
            SupervisorWatchMetric::Disk => self.disk_bytes_per_second as f32 / MEBIBYTE,
        }
    }
}

fn aggregate_applications(processes: &[ProcessRow]) -> Vec<ApplicationAggregate> {
    let mut groups = HashMap::<String, ApplicationAggregate>::new();
    for process in processes {
        let application_id = process
            .application_id
            .clone()
            .unwrap_or_else(|| format!("name:{}", process.name.to_lowercase()));
        let entry = groups
            .entry(application_id.clone())
            .or_insert_with(|| ApplicationAggregate {
                application_id,
                name: process.name.clone(),
                cpu_percent: 0.0,
                memory_bytes: 0,
                disk_bytes_per_second: 0,
            });
        entry.cpu_percent += process.cpu_percent.unwrap_or(0.0).max(0.0);
        entry.memory_bytes = entry.memory_bytes.saturating_add(process.memory_bytes);
        entry.disk_bytes_per_second = entry.disk_bytes_per_second.saturating_add(
            process
                .disk_read_bytes_per_second
                .unwrap_or(0)
                .saturating_add(process.disk_write_bytes_per_second.unwrap_or(0)),
        );
    }
    groups.into_values().collect()
}

fn memory_pressure_percent(memory: &MemorySnapshot) -> f32 {
    if memory.total_bytes == 0 {
        return 0.0;
    }
    let available_percent = memory.available_bytes as f32 / memory.total_bytes as f32 * 100.0;
    let used_percent = memory.used_bytes as f32 / memory.total_bytes as f32 * 100.0;
    let meaningful_swap = memory.swap_used_bytes >= 512 * 1_048_576
        && (memory.swap_total_bytes == 0
            || memory.swap_used_bytes as f64 / memory.swap_total_bytes as f64 >= 0.1);
    let immediate_pressure = available_percent <= 3.0 && memory.swap_used_bytes >= 1_073_741_824;
    if immediate_pressure || available_percent <= 10.0 && meaningful_swap {
        used_percent.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn resource_copy(
    copies: &SupervisorNotificationCopies,
    resource: SupervisorResource,
) -> &SupervisorResourceCopy {
    match resource {
        SupervisorResource::Cpu => &copies.cpu,
        SupervisorResource::Memory => &copies.memory,
        SupervisorResource::Volume => &copies.volume,
    }
}

fn resource_name(resource: SupervisorResource) -> &'static str {
    match resource {
        SupervisorResource::Cpu => "cpu",
        SupervisorResource::Memory => "memory",
        SupervisorResource::Volume => "volume",
    }
}

fn watch_metric_copy(
    copy: &SupervisorWatchCopy,
    metric: SupervisorWatchMetric,
    value: f32,
) -> String {
    let (template, formatted) = match metric {
        SupervisorWatchMetric::Cpu => (&copy.cpu_metric, format!("{value:.0}")),
        SupervisorWatchMetric::Memory => (&copy.memory_metric, format!("{value:.0}")),
        SupervisorWatchMetric::Disk => (&copy.disk_metric, format!("{value:.1}")),
    };
    template.replace("{{value}}", &formatted)
}

fn render_template(template: &str, application: &str, metric: &str, seconds: u64) -> String {
    template
        .replace("{{application}}", application)
        .replace("{{metric}}", metric)
        .replace("{{seconds}}", &seconds.to_string())
}

fn deliver_notification(
    app: &AppHandle,
    kind: &'static str,
    copy: &SupervisorNotificationCopy,
    extra: Option<(&str, &str)>,
) {
    if copy.title.trim().is_empty() || copy.body.trim().is_empty() {
        return;
    }
    let mut builder = app
        .notification()
        .builder()
        .title(copy.title.clone())
        .body(copy.body.clone());
    if let Some((key, value)) = extra {
        builder = builder.extra(key, value);
    }
    let attempted_at_ms = now_millis();
    let status = if builder.show().is_ok() {
        "sent"
    } else {
        "failed"
    };
    let _ = app.emit(
        SUPERVISOR_NOTIFICATION_EVENT,
        SupervisorNotificationDelivery {
            kind,
            status,
            attempted_at_ms,
        },
    );
}

fn summary_from_snapshot(snapshot: &SystemSnapshot) -> SystemSummary {
    SystemSummary {
        sequence: snapshot.sequence,
        sampled_at_ms: snapshot.sampled_at_ms,
        sample_interval_ms: snapshot.sample_interval_ms,
        cpu: snapshot.cpu.clone(),
        memory: snapshot.memory.clone(),
        disk: snapshot.disk.clone(),
        network: snapshot.network.clone(),
        sensors: snapshot.sensors.clone(),
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_alert_requires_real_pressure_instead_of_used_memory_alone() {
        let comfortable = MemorySnapshot {
            total_bytes: 16 * 1_073_741_824,
            used_bytes: 15 * 1_073_741_824,
            available_bytes: 2 * 1_073_741_824,
            swap_total_bytes: 4 * 1_073_741_824,
            swap_used_bytes: 0,
        };
        let pressured = MemorySnapshot {
            available_bytes: 256 * 1_048_576,
            swap_used_bytes: 2 * 1_073_741_824,
            ..comfortable.clone()
        };

        assert_eq!(memory_pressure_percent(&comfortable), 0.0);
        assert!(memory_pressure_percent(&pressured) > 90.0);
    }

    #[test]
    fn watch_copy_is_rendered_without_exposing_command_or_path_data() {
        assert_eq!(
            render_template(
                "{{application}}: {{metric}} for {{seconds}} seconds",
                "Example",
                "CPU 81%",
                30,
            ),
            "Example: CPU 81% for 30 seconds"
        );
    }
}
