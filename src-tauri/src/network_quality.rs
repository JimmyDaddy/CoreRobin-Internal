use std::collections::HashSet;
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::models::{
    NetworkHostLookup, NetworkHostLookupRequest, NetworkQualityResult, NetworkQualityStatus,
};

const QUALITY_TARGET_HOST: &str = "example.com";
const QUALITY_TARGET_PORT: u16 = 443;
const PROBE_COUNT: usize = 6;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(900);
const MAX_LOOKUP_ADDRESSES: usize = 32;

pub fn run_network_quality_check() -> Result<NetworkQualityResult, CommandError> {
    let sampled_at_ms = now_millis();
    let dns_started = Instant::now();
    let resolved = (QUALITY_TARGET_HOST, QUALITY_TARGET_PORT)
        .to_socket_addrs()
        .map(|addresses| addresses.collect::<Vec<_>>());
    let dns_lookup_ms = dns_started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let addresses = resolved.unwrap_or_default();
    let dns_available = !addresses.is_empty();
    let mut unique_addresses = Vec::new();
    let mut seen = HashSet::new();
    for address in addresses {
        if seen.insert(address.ip()) {
            unique_addresses.push(address);
        }
    }

    let mut successful_latencies = Vec::new();
    for probe_index in 0..PROBE_COUNT {
        if let Some(address) = unique_addresses.get(probe_index % unique_addresses.len().max(1)) {
            let started = Instant::now();
            if TcpStream::connect_timeout(address, CONNECT_TIMEOUT).is_ok() {
                successful_latencies.push(started.elapsed().as_secs_f64() * 1_000.0);
            }
        }
    }

    let successful_probe_count = successful_latencies.len();
    let average_latency_ms = mean(&successful_latencies);
    let minimum_latency_ms = successful_latencies.iter().copied().reduce(f64::min);
    let maximum_latency_ms = successful_latencies.iter().copied().reduce(f64::max);
    let jitter_samples = successful_latencies
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .collect::<Vec<_>>();
    let jitter_ms = mean(&jitter_samples);
    let packet_loss_percent =
        ((PROBE_COUNT - successful_probe_count) as f64 / PROBE_COUNT as f64) * 100.0;
    let status = if successful_probe_count >= PROBE_COUNT.div_ceil(2) {
        NetworkQualityStatus::Online
    } else if successful_probe_count > 0 || dns_available {
        NetworkQualityStatus::Limited
    } else {
        NetworkQualityStatus::Offline
    };

    Ok(NetworkQualityResult {
        sampled_at_ms,
        target_host: QUALITY_TARGET_HOST.to_owned(),
        target_port: QUALITY_TARGET_PORT,
        status,
        dns_available,
        dns_lookup_ms: dns_available.then_some(dns_lookup_ms),
        resolved_address_count: unique_addresses.len(),
        probe_count: PROBE_COUNT,
        successful_probe_count,
        average_latency_ms,
        minimum_latency_ms,
        maximum_latency_ms,
        jitter_ms,
        packet_loss_percent,
    })
}

pub fn resolve_network_hosts(request: NetworkHostLookupRequest) -> Vec<NetworkHostLookup> {
    let mut seen = HashSet::new();
    request
        .addresses
        .into_iter()
        .filter(|address| seen.insert(address.clone()))
        .take(MAX_LOOKUP_ADDRESSES)
        .map(|address| {
            let hostname = address
                .parse::<IpAddr>()
                .ok()
                .and_then(|ip| dns_lookup::lookup_addr(&ip).ok())
                .filter(|hostname| hostname != &address);
            NetworkHostLookup { address, hostname }
        })
        .collect()
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::mean;

    #[test]
    fn mean_handles_empty_and_non_empty_samples() {
        assert_eq!(mean(&[]), None);
        assert_eq!(mean(&[10.0, 20.0, 30.0]), Some(20.0));
    }
}
