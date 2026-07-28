use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::models::{
    NetworkHostLookup, NetworkHostLookupRequest, NetworkQualityDiagnostic,
    NetworkQualityDiagnosticKind, NetworkQualityDiagnosticStatus, NetworkQualityResult,
    NetworkQualityStatus,
};

const QUALITY_TARGETS: [(&str, u16); 2] = [("example.com", 443), ("one.one.one.one", 443)];
const PROBE_COUNT: usize = 6;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(900);
const ROUTE_PROBE_V4: &str = "1.1.1.1:443";
const ROUTE_PROBE_V6: &str = "[2606:4700:4700::1111]:443";
const MAX_LOOKUP_ADDRESSES: usize = 32;

pub fn run_network_quality_check() -> Result<NetworkQualityResult, CommandError> {
    let sampled_at_ms = now_millis();
    let dns_started = Instant::now();
    let target_addresses = QUALITY_TARGETS
        .iter()
        .map(|(host, port)| {
            (*host, *port)
                .to_socket_addrs()
                .map(|addresses| {
                    let mut seen = HashSet::new();
                    addresses
                        .filter(|address| seen.insert(address.ip()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let dns_lookup_ms = dns_started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let resolved_target_count = target_addresses
        .iter()
        .filter(|addresses| !addresses.is_empty())
        .count();
    let dns_available = resolved_target_count > 0;
    let unique_addresses = target_addresses
        .iter()
        .flatten()
        .copied()
        .collect::<Vec<_>>();

    let mut successful_latencies = Vec::new();
    let mut ipv4_successes = 0usize;
    let mut ipv6_successes = 0usize;
    let mut target_successes = vec![false; QUALITY_TARGETS.len()];
    for probe_index in 0..PROBE_COUNT {
        let target_index = probe_index % QUALITY_TARGETS.len();
        let addresses = &target_addresses[target_index];
        let Some(address) =
            addresses.get((probe_index / QUALITY_TARGETS.len()) % addresses.len().max(1))
        else {
            continue;
        };
        let Some(latency) = probe_address(*address) else {
            continue;
        };
        target_successes[target_index] = true;
        successful_latencies.push(latency);
        if address.is_ipv4() {
            ipv4_successes += 1;
        } else {
            ipv6_successes += 1;
        }
    }

    let successful_probe_count = successful_latencies.len();
    let successful_target_count = target_successes
        .iter()
        .filter(|succeeded| **succeeded)
        .count();
    let resolved_ipv4 = unique_addresses
        .iter()
        .filter(|address| address.is_ipv4())
        .count();
    let resolved_ipv6 = unique_addresses
        .iter()
        .filter(|address| address.is_ipv6())
        .count();
    let route_v4 = local_route_available(false);
    let route_v6 = local_route_available(true);
    let direct_v4_latency = ROUTE_PROBE_V4
        .parse::<SocketAddr>()
        .ok()
        .and_then(probe_address);
    let direct_v6_latency = route_v6
        .then(|| {
            ROUTE_PROBE_V6
                .parse::<SocketAddr>()
                .ok()
                .and_then(probe_address)
        })
        .flatten();
    let average_latency_ms = mean(&successful_latencies);
    let minimum_latency_ms = successful_latencies.iter().copied().reduce(f64::min);
    let maximum_latency_ms = successful_latencies.iter().copied().reduce(f64::max);
    let jitter_samples = successful_latencies
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .collect::<Vec<_>>();
    let jitter_ms = mean(&jitter_samples);
    let tcp_probe_failure_percent =
        ((PROBE_COUNT - successful_probe_count) as f64 / PROBE_COUNT as f64) * 100.0;
    let status = if successful_probe_count >= PROBE_COUNT.div_ceil(2) {
        NetworkQualityStatus::Online
    } else if successful_probe_count > 0 || dns_available {
        NetworkQualityStatus::Limited
    } else {
        NetworkQualityStatus::Offline
    };
    let internet_latency = [direct_v4_latency, direct_v6_latency]
        .into_iter()
        .flatten()
        .reduce(f64::min);
    let diagnostics = vec![
        diagnostic(
            NetworkQualityDiagnosticKind::LocalLink,
            if route_v4 || route_v6 {
                NetworkQualityDiagnosticStatus::Passed
            } else {
                NetworkQualityDiagnosticStatus::Failed
            },
            None,
        ),
        diagnostic(
            NetworkQualityDiagnosticKind::Dns,
            if resolved_target_count == QUALITY_TARGETS.len() {
                NetworkQualityDiagnosticStatus::Passed
            } else if dns_available {
                NetworkQualityDiagnosticStatus::Degraded
            } else {
                NetworkQualityDiagnosticStatus::Failed
            },
            dns_available.then_some(dns_lookup_ms as f64),
        ),
        diagnostic(
            NetworkQualityDiagnosticKind::Ipv4,
            address_family_status(resolved_ipv4, ipv4_successes),
            None,
        ),
        diagnostic(
            NetworkQualityDiagnosticKind::Ipv6,
            address_family_status(resolved_ipv6, ipv6_successes),
            None,
        ),
        diagnostic(
            NetworkQualityDiagnosticKind::Internet,
            if internet_latency.is_some() {
                NetworkQualityDiagnosticStatus::Passed
            } else if successful_probe_count > 0 {
                NetworkQualityDiagnosticStatus::Degraded
            } else {
                NetworkQualityDiagnosticStatus::Failed
            },
            internet_latency,
        ),
        diagnostic(
            NetworkQualityDiagnosticKind::IndependentService,
            if successful_target_count == QUALITY_TARGETS.len() {
                NetworkQualityDiagnosticStatus::Passed
            } else if successful_target_count > 0 {
                NetworkQualityDiagnosticStatus::Degraded
            } else {
                NetworkQualityDiagnosticStatus::Failed
            },
            average_latency_ms,
        ),
    ];

    Ok(NetworkQualityResult {
        sampled_at_ms,
        target_host: QUALITY_TARGETS
            .iter()
            .map(|(host, _)| *host)
            .collect::<Vec<_>>()
            .join(", "),
        target_port: 443,
        target_count: QUALITY_TARGETS.len(),
        successful_target_count,
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
        tcp_probe_failure_percent,
        diagnostics,
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

fn probe_address(address: SocketAddr) -> Option<f64> {
    let started = Instant::now();
    TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .is_ok()
        .then(|| started.elapsed().as_secs_f64() * 1_000.0)
}

fn local_route_available(ipv6: bool) -> bool {
    let bind_address = if ipv6 { "[::]:0" } else { "0.0.0.0:0" };
    let target = if ipv6 { ROUTE_PROBE_V6 } else { ROUTE_PROBE_V4 };
    UdpSocket::bind(bind_address)
        .and_then(|socket| {
            socket.connect(target)?;
            socket.local_addr()
        })
        .is_ok_and(|address| !address.ip().is_unspecified())
}

fn address_family_status(
    resolved_address_count: usize,
    successful_probe_count: usize,
) -> NetworkQualityDiagnosticStatus {
    if resolved_address_count == 0 {
        NetworkQualityDiagnosticStatus::Unavailable
    } else if successful_probe_count > 0 {
        NetworkQualityDiagnosticStatus::Passed
    } else {
        NetworkQualityDiagnosticStatus::Failed
    }
}

fn diagnostic(
    kind: NetworkQualityDiagnosticKind,
    status: NetworkQualityDiagnosticStatus,
    latency_ms: Option<f64>,
) -> NetworkQualityDiagnostic {
    NetworkQualityDiagnostic {
        kind,
        status,
        latency_ms,
    }
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
    use super::{address_family_status, mean};
    use crate::models::NetworkQualityDiagnosticStatus;

    #[test]
    fn mean_handles_empty_and_non_empty_samples() {
        assert_eq!(mean(&[]), None);
        assert_eq!(mean(&[10.0, 20.0, 30.0]), Some(20.0));
    }

    #[test]
    fn address_family_status_distinguishes_missing_and_failed_routes() {
        assert_eq!(
            address_family_status(0, 0),
            NetworkQualityDiagnosticStatus::Unavailable
        );
        assert_eq!(
            address_family_status(2, 0),
            NetworkQualityDiagnosticStatus::Failed
        );
        assert_eq!(
            address_family_status(2, 1),
            NetworkQualityDiagnosticStatus::Passed
        );
    }
}
