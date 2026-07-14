use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;
use crate::models::{
    NetworkAddressFamily, NetworkConnection, NetworkConnectionState, NetworkConnectionSummary,
    NetworkConnectionsSnapshot, NetworkEndpoint, NetworkProcessAttribution,
    NetworkTransportProtocol,
};

const MAX_CONNECTION_ROWS: usize = 500;

pub fn sample_network_connections() -> Result<NetworkConnectionsSnapshot, CommandError> {
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        let (connections, skipped_entry_count) = collect_supported_connections()?;
        Ok(build_snapshot(
            now_ms(),
            connections,
            skipped_entry_count,
            MAX_CONNECTION_ROWS,
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Err(CommandError::new(
            "network_connections_unavailable",
            "Active connection enumeration is unavailable on this platform.",
        ))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

fn build_snapshot(
    sampled_at_ms: u64,
    mut connections: Vec<NetworkConnection>,
    skipped_entry_count: usize,
    maximum_rows: usize,
) -> NetworkConnectionsSnapshot {
    let summary = summarize_connections(&connections);
    sort_connections(&mut connections);
    let truncated = connections.len() > maximum_rows;
    connections.truncate(maximum_rows);
    NetworkConnectionsSnapshot {
        sampled_at_ms,
        summary,
        connections,
        process_attribution: process_attribution(),
        truncated,
        skipped_entry_count,
    }
}

fn summarize_connections(connections: &[NetworkConnection]) -> NetworkConnectionSummary {
    let mut summary = NetworkConnectionSummary {
        total_count: connections.len(),
        ..NetworkConnectionSummary::default()
    };
    for connection in connections {
        match connection.protocol {
            NetworkTransportProtocol::Tcp => summary.tcp_count += 1,
            NetworkTransportProtocol::Udp => summary.udp_count += 1,
        }
        match connection.state {
            NetworkConnectionState::Established => summary.established_count += 1,
            NetworkConnectionState::Listen => summary.listening_count += 1,
            _ => {}
        }
        if !connection.associated_pids.is_empty() {
            summary.attributed_count += 1;
        }
    }
    summary
}

fn sort_connections(connections: &mut [NetworkConnection]) {
    connections.sort_by(|left, right| {
        state_rank(left.state)
            .cmp(&state_rank(right.state))
            .then_with(|| protocol_rank(left.protocol).cmp(&protocol_rank(right.protocol)))
            .then_with(|| {
                left.local_endpoint
                    .address
                    .cmp(&right.local_endpoint.address)
            })
            .then_with(|| left.local_endpoint.port.cmp(&right.local_endpoint.port))
            .then_with(|| left.remote_endpoint.cmp(&right.remote_endpoint))
    });
}

fn state_rank(state: NetworkConnectionState) -> u8 {
    match state {
        NetworkConnectionState::Established => 0,
        NetworkConnectionState::Listen => 1,
        NetworkConnectionState::SynSent | NetworkConnectionState::SynReceived => 2,
        NetworkConnectionState::CloseWait
        | NetworkConnectionState::FinWait1
        | NetworkConnectionState::FinWait2
        | NetworkConnectionState::Closing
        | NetworkConnectionState::LastAck => 3,
        NetworkConnectionState::Unconnected => 4,
        NetworkConnectionState::TimeWait => 5,
        NetworkConnectionState::Closed
        | NetworkConnectionState::DeleteTcb
        | NetworkConnectionState::Unknown => 6,
    }
}

fn protocol_rank(protocol: NetworkTransportProtocol) -> u8 {
    match protocol {
        NetworkTransportProtocol::Tcp => 0,
        NetworkTransportProtocol::Udp => 1,
    }
}

fn process_attribution() -> NetworkProcessAttribution {
    #[cfg(windows)]
    {
        NetworkProcessAttribution::Available
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        NetworkProcessAttribution::Partial
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        NetworkProcessAttribution::Unavailable
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn collect_supported_connections() -> Result<(Vec<NetworkConnection>, usize), CommandError> {
    use netstat2::{AddressFamilyFlags, ProtocolFlags};

    let address_families = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
    let protocols = ProtocolFlags::TCP | ProtocolFlags::UDP;
    let results = socket_results(address_families, protocols).map_err(|error| {
        CommandError::new(
            "network_connections_unavailable",
            format!("Could not enumerate active network connections: {error}"),
        )
    })?;

    let mut connections = Vec::new();
    let mut skipped_entry_count = 0;
    for result in results {
        match result {
            Ok(socket) => connections.push(connection_from_socket(socket)),
            Err(_) => skipped_entry_count += 1,
        }
    }
    Ok((connections, skipped_entry_count))
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn socket_results(
    address_families: netstat2::AddressFamilyFlags,
    protocols: netstat2::ProtocolFlags,
) -> Result<Vec<Result<netstat2::SocketInfo, netstat2::error::Error>>, netstat2::error::Error> {
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    let iterator = netstat2::iterate_sockets_info(address_families, protocols)?;

    Ok(iterator.collect())
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn connection_from_socket(socket: netstat2::SocketInfo) -> NetworkConnection {
    use netstat2::ProtocolSocketInfo;

    let mut associated_pids = socket.associated_pids;
    associated_pids.sort_unstable();
    associated_pids.dedup();

    match socket.protocol_socket_info {
        ProtocolSocketInfo::Tcp(tcp) => {
            let address_family = address_family(tcp.local_addr);
            let remote_endpoint = (!tcp.remote_addr.is_unspecified() || tcp.remote_port != 0)
                .then(|| endpoint(tcp.remote_addr, tcp.remote_port));
            NetworkConnection {
                protocol: NetworkTransportProtocol::Tcp,
                address_family,
                local_endpoint: endpoint(tcp.local_addr, tcp.local_port),
                remote_endpoint,
                state: tcp_state(tcp.state),
                associated_pids,
            }
        }
        ProtocolSocketInfo::Udp(udp) => NetworkConnection {
            protocol: NetworkTransportProtocol::Udp,
            address_family: address_family(udp.local_addr),
            local_endpoint: endpoint(udp.local_addr, udp.local_port),
            remote_endpoint: None,
            state: NetworkConnectionState::Unconnected,
            associated_pids,
        },
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn endpoint(address: std::net::IpAddr, port: u16) -> NetworkEndpoint {
    NetworkEndpoint {
        address: address.to_string(),
        port,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn address_family(address: std::net::IpAddr) -> NetworkAddressFamily {
    match address {
        std::net::IpAddr::V4(_) => NetworkAddressFamily::Ipv4,
        std::net::IpAddr::V6(_) => NetworkAddressFamily::Ipv6,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn tcp_state(state: netstat2::TcpState) -> NetworkConnectionState {
    match state {
        netstat2::TcpState::Closed => NetworkConnectionState::Closed,
        netstat2::TcpState::Listen => NetworkConnectionState::Listen,
        netstat2::TcpState::SynSent => NetworkConnectionState::SynSent,
        netstat2::TcpState::SynReceived => NetworkConnectionState::SynReceived,
        netstat2::TcpState::Established => NetworkConnectionState::Established,
        netstat2::TcpState::FinWait1 => NetworkConnectionState::FinWait1,
        netstat2::TcpState::FinWait2 => NetworkConnectionState::FinWait2,
        netstat2::TcpState::CloseWait => NetworkConnectionState::CloseWait,
        netstat2::TcpState::Closing => NetworkConnectionState::Closing,
        netstat2::TcpState::LastAck => NetworkConnectionState::LastAck,
        netstat2::TcpState::TimeWait => NetworkConnectionState::TimeWait,
        netstat2::TcpState::DeleteTcb => NetworkConnectionState::DeleteTcb,
        netstat2::TcpState::Unknown => NetworkConnectionState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_snapshot, sort_connections, summarize_connections};
    use crate::models::{
        NetworkAddressFamily, NetworkConnection, NetworkConnectionState, NetworkEndpoint,
        NetworkTransportProtocol,
    };

    fn connection(
        protocol: NetworkTransportProtocol,
        state: NetworkConnectionState,
        local_port: u16,
    ) -> NetworkConnection {
        NetworkConnection {
            protocol,
            address_family: NetworkAddressFamily::Ipv4,
            local_endpoint: NetworkEndpoint {
                address: "127.0.0.1".to_owned(),
                port: local_port,
            },
            remote_endpoint: None,
            state,
            associated_pids: Vec::new(),
        }
    }

    #[test]
    fn summarizes_protocols_and_primary_tcp_states() {
        let mut connections = vec![
            connection(
                NetworkTransportProtocol::Tcp,
                NetworkConnectionState::Established,
                40_000,
            ),
            connection(
                NetworkTransportProtocol::Tcp,
                NetworkConnectionState::Listen,
                8_080,
            ),
            connection(
                NetworkTransportProtocol::Udp,
                NetworkConnectionState::Unconnected,
                53,
            ),
        ];
        connections[0].associated_pids = vec![42];

        let summary = summarize_connections(&connections);
        assert_eq!(summary.total_count, 3);
        assert_eq!(summary.tcp_count, 2);
        assert_eq!(summary.udp_count, 1);
        assert_eq!(summary.established_count, 1);
        assert_eq!(summary.listening_count, 1);
        assert_eq!(summary.attributed_count, 1);
    }

    #[test]
    fn sorts_established_and_listening_connections_first() {
        let mut connections = vec![
            connection(
                NetworkTransportProtocol::Udp,
                NetworkConnectionState::Unconnected,
                53,
            ),
            connection(
                NetworkTransportProtocol::Tcp,
                NetworkConnectionState::Listen,
                8_080,
            ),
            connection(
                NetworkTransportProtocol::Tcp,
                NetworkConnectionState::Established,
                40_000,
            ),
        ];

        sort_connections(&mut connections);
        assert_eq!(connections[0].state, NetworkConnectionState::Established);
        assert_eq!(connections[1].state, NetworkConnectionState::Listen);
        assert_eq!(connections[2].state, NetworkConnectionState::Unconnected);
    }

    #[test]
    fn retains_full_summary_when_rows_are_truncated() {
        let connections = vec![
            connection(
                NetworkTransportProtocol::Tcp,
                NetworkConnectionState::Established,
                40_000,
            ),
            connection(
                NetworkTransportProtocol::Tcp,
                NetworkConnectionState::Listen,
                8_080,
            ),
        ];

        let snapshot = build_snapshot(123, connections, 2, 1);
        assert_eq!(snapshot.sampled_at_ms, 123);
        assert_eq!(snapshot.summary.total_count, 2);
        assert_eq!(snapshot.connections.len(), 1);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.skipped_entry_count, 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn samples_a_live_local_listener_without_elevated_privileges() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().expect("read listener address").port();
        let (connections, _) =
            super::collect_supported_connections().expect("enumerate active network connections");

        let connection = connections.iter().find(|connection| {
            connection.protocol == NetworkTransportProtocol::Tcp
                && connection.state == NetworkConnectionState::Listen
                && connection.local_endpoint.port == port
        });
        assert!(connection.is_some());
        assert!(
            connection
                .expect("find test listener")
                .associated_pids
                .contains(&std::process::id())
        );
    }
}
