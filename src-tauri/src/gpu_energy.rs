use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::models::GpuAdapterSnapshot;
use crate::models::GpuEnergySnapshot;
#[cfg(target_os = "macos")]
use crate::models::ProcessEnergySample;

pub fn sample_gpu_energy() -> GpuEnergySnapshot {
    let snapshot = GpuEnergySnapshot {
        sampled_at_ms: now_millis(),
        gpu_available: false,
        process_energy_available: false,
        adapters: Vec::new(),
        process_energy: Vec::new(),
    };

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let mut snapshot = snapshot;
        #[cfg(target_os = "macos")]
        sample_macos(&mut snapshot);
        #[cfg(target_os = "linux")]
        sample_linux(&mut snapshot);
        snapshot
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        snapshot
    }
}

#[cfg(target_os = "macos")]
fn sample_macos(snapshot: &mut GpuEnergySnapshot) {
    if let Ok(output) = Command::new("ioreg")
        .args(["-l", "-w", "0", "-r", "-c", "AGXAccelerator"])
        .output()
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.trim().is_empty() {
            let name = find_string_value(&text, "model").unwrap_or_else(|| "Apple GPU".to_owned());
            snapshot.adapters.push(GpuAdapterSnapshot {
                name,
                utilization_percent: find_number_value(&text, "Device Utilization %")
                    .map(|value| value.clamp(0, 100) as f32),
                memory_used_bytes: find_number_value(&text, "In use system memory"),
                memory_total_bytes: None,
                core_count: find_number_value(&text, "gpu-core-count")
                    .and_then(|value| u32::try_from(value).ok()),
            });
            snapshot.gpu_available = true;
        }
    }

    if let Ok(output) = Command::new("top")
        .args(["-l", "1", "-o", "power", "-n", "20", "-stats", "pid,power"])
        .output()
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        snapshot.process_energy = text
            .lines()
            .filter_map(|line| {
                let mut columns = line.split_whitespace();
                let pid = columns.next()?.parse::<u32>().ok()?;
                let impact = columns.next()?.parse::<f32>().ok()?;
                impact
                    .is_finite()
                    .then_some(ProcessEnergySample { pid, impact })
            })
            .collect();
        snapshot.process_energy_available = !snapshot.process_energy.is_empty();
    }
}

#[cfg(target_os = "linux")]
fn sample_linux(snapshot: &mut GpuEnergySnapshot) {
    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let busy_path = entry.path().join("device/gpu_busy_percent");
        let utilization_percent = fs::read_to_string(busy_path)
            .ok()
            .and_then(|value| value.trim().parse::<f32>().ok())
            .map(|value| value.clamp(0.0, 100.0));
        if utilization_percent.is_some() {
            snapshot.adapters.push(GpuAdapterSnapshot {
                name,
                utilization_percent,
                memory_used_bytes: None,
                memory_total_bytes: None,
                core_count: None,
            });
        }
    }
    snapshot.gpu_available = !snapshot.adapters.is_empty();
}

#[cfg(target_os = "macos")]
fn find_number_value(text: &str, key: &str) -> Option<u64> {
    let marker = format!("\"{key}\"");
    let tail = text.split_once(&marker)?.1;
    let value = tail.split_once('=')?.1.trim_start();
    let digits = value
        .trim_start_matches(['<', '"'])
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    digits.parse().ok()
}

#[cfg(target_os = "macos")]
fn find_string_value(text: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\"");
    let tail = text.split_once(&marker)?.1;
    let value = tail.split_once('=')?.1.trim_start();
    let value = value.trim_start_matches('<').trim_start_matches('"');
    let end = value.find(['"', '>'])?;
    let result = value[..end].trim();
    (!result.is_empty()).then(|| result.to_owned())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::{find_number_value, find_string_value};

    #[test]
    fn parses_ioreg_values() {
        let input = r#""model" = <"Apple M3 Pro"> "Device Utilization %"=53 "gpu-core-count"=14"#;
        assert_eq!(
            find_string_value(input, "model").as_deref(),
            Some("Apple M3 Pro")
        );
        assert_eq!(find_number_value(input, "Device Utilization %"), Some(53));
        assert_eq!(find_number_value(input, "gpu-core-count"), Some(14));
    }
}
