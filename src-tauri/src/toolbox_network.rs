use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::Networks;

const MAX_INTERFACES: usize = 128;
const MAX_ADDRESSES_PER_INTERFACE: usize = 64;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxNetworkSnapshot {
    pub sampled_at_ms: u64,
    pub interfaces: Vec<ToolboxNetworkInterfaceSnapshot>,
    pub interfaces_truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxNetworkInterfaceSnapshot {
    pub name: String,
    pub mtu: u64,
    pub mac_address: Option<String>,
    pub ip_networks: Vec<String>,
    pub operational_state: String,
    pub addresses_truncated: bool,
}

/// Take a fresh interface-only snapshot. This intentionally constructs its own `Networks`
/// reader, so a paused SystemMonitor cannot make the toolbox address view stale or unavailable.
/// No route, DNS, socket, shell, or network-quality probe is used here.
pub fn collect_network_snapshot() -> ToolboxNetworkSnapshot {
    let networks = Networks::new_with_refreshed_list();
    let mut interfaces = networks
        .list()
        .iter()
        .map(|(name, network)| {
            let (ip_networks, addresses_truncated) = bounded_ip_networks(network.ip_networks());
            ToolboxNetworkInterfaceSnapshot {
                name: name.clone(),
                mtu: network.mtu(),
                mac_address: {
                    let mac = network.mac_address();
                    (!mac.is_unspecified()).then(|| mac.to_string())
                },
                ip_networks,
                operational_state: network.operational_state().to_string(),
                addresses_truncated,
            }
        })
        .collect::<Vec<_>>();
    interfaces.sort_by(|left, right| left.name.cmp(&right.name));
    let interfaces_truncated = interfaces.len() > MAX_INTERFACES;
    interfaces.truncate(MAX_INTERFACES);

    ToolboxNetworkSnapshot {
        sampled_at_ms: now_millis(),
        interfaces,
        interfaces_truncated,
    }
}

fn bounded_ip_networks(networks: &[sysinfo::IpNetwork]) -> (Vec<String>, bool) {
    let truncated = networks.len() > MAX_ADDRESSES_PER_INTERFACE;
    let values = networks
        .iter()
        .take(MAX_ADDRESSES_PER_INTERFACE)
        .map(ToString::to_string)
        .collect();
    (values, truncated)
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
    use super::{MAX_ADDRESSES_PER_INTERFACE, bounded_ip_networks};

    #[test]
    fn bounds_interface_addresses_without_executing_or_probing() {
        let addresses = (0..=MAX_ADDRESSES_PER_INTERFACE)
            .map(|index| {
                format!("192.0.2.{}/32", index % 255)
                    .parse()
                    .expect("fixture is valid")
            })
            .collect::<Vec<_>>();
        let (bounded, truncated) = bounded_ip_networks(&addresses);
        assert_eq!(bounded.len(), MAX_ADDRESSES_PER_INTERFACE);
        assert!(truncated);
    }

    #[test]
    fn allows_empty_addresses_and_reports_no_truncation() {
        let (bounded, truncated) = bounded_ip_networks(&[]);
        assert!(bounded.is_empty());
        assert!(!truncated);
    }
}
