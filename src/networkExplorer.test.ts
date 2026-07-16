import { describe, expect, it } from "vitest";

import {
  NETWORK_HISTORY_WINDOW_MS,
  filterNetworkConnections,
  formatNetworkEndpoint,
  indexNetworkProcesses,
  networkHistorySegments,
  networkHistoryWindow,
  networkInterfaceRate,
  resolveNetworkConnectionOwners,
  sortNetworkInterfaces,
  visibleNetworkInterfaces,
} from "./networkExplorer";
import type {
  HistoryPoint,
  NetworkConnection,
  NetworkInterfaceSnapshot,
  ProcessRow,
} from "./types";

function interfaceFixture(
  name: string,
  received: number | null,
  transmitted: number | null,
  options: Partial<NetworkInterfaceSnapshot> = {},
): NetworkInterfaceSnapshot {
  return {
    name,
    receivedBytesPerSecond: received,
    transmittedBytesPerSecond: transmitted,
    receivedBytesSinceLaunch: received ?? 0,
    transmittedBytesSinceLaunch: transmitted ?? 0,
    packetsReceivedSinceLaunch: 0,
    packetsTransmittedSinceLaunch: 0,
    receiveErrorsSinceLaunch: 0,
    transmitErrorsSinceLaunch: 0,
    mtu: 1_500,
    macAddress: null,
    ipNetworks: [],
    operationalState: "up",
    ...options,
  };
}

const connectionFixtures: NetworkConnection[] = [
  {
    protocol: "tcp",
    addressFamily: "ipv4",
    localEndpoint: { address: "127.0.0.1", port: 4_000 },
    remoteEndpoint: { address: "203.0.113.10", port: 443 },
    state: "established",
    associatedPids: [42],
  },
  {
    protocol: "tcp",
    addressFamily: "ipv6",
    localEndpoint: { address: "::", port: 8_080 },
    remoteEndpoint: null,
    state: "listen",
    associatedPids: [],
  },
  {
    protocol: "udp",
    addressFamily: "ipv4",
    localEndpoint: { address: "0.0.0.0", port: 53 },
    remoteEndpoint: null,
    state: "unconnected",
    associatedPids: [],
  },
];

describe("network connections", () => {
  it("filters by protocol and important TCP states", () => {
    expect(filterNetworkConnections(connectionFixtures, "tcp")).toHaveLength(2);
    expect(filterNetworkConnections(connectionFixtures, "udp")).toEqual([
      connectionFixtures[2],
    ]);
    expect(filterNetworkConnections(connectionFixtures, "established")).toEqual([
      connectionFixtures[0],
    ]);
    expect(filterNetworkConnections(connectionFixtures, "listen")).toEqual([
      connectionFixtures[1],
    ]);
  });

  it("formats IPv4, IPv6, and absent endpoints without ambiguity", () => {
    expect(formatNetworkEndpoint(connectionFixtures[0].localEndpoint)).toBe(
      "127.0.0.1:4000",
    );
    expect(formatNetworkEndpoint(connectionFixtures[1].localEndpoint)).toBe(
      "[::]:8080",
    );
    expect(formatNetworkEndpoint(null)).toBe("—");
  });

  it("resolves reported owners against the current process snapshot", () => {
    const process = {
      pid: 42,
      birthToken: "test:42",
      parentPid: 1,
      startTime: 100,
      runTimeSeconds: 10,
      name: "core-robin-test",
      user: "tester",
      status: "Run",
      cpuPercent: 1,
      memoryBytes: 1_024,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
      protected: false,
    } satisfies ProcessRow;
    const connection = {
      ...connectionFixtures[0],
      associatedPids: [99, 42, 42],
    };

    const index = indexNetworkProcesses([process]);
    expect(resolveNetworkConnectionOwners(connection, index)).toEqual({
      processes: [process],
      unavailablePids: [99],
    });
  });

  it("builds one reusable PID index for 100 and 500 visible rows", () => {
    const processes = Array.from({ length: 250 }, (_, index) => ({
      pid: index + 1,
      birthToken: `test:${index + 1}`,
      parentPid: 1,
      startTime: 100,
      runTimeSeconds: 10,
      name: `process-${index + 1}`,
      user: "tester",
      status: "Run",
      cpuPercent: 1,
      memoryBytes: 1_024,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
      protected: false,
    } satisfies ProcessRow));
    const index = indexNetworkProcesses(processes);
    const rows = Array.from({ length: 500 }, (_, row) => ({
      ...connectionFixtures[0],
      associatedPids: [((row * 7) % 300) + 1, ((row * 7) % 300) + 1],
    }));

    const firstPage = rows
      .slice(0, 100)
      .map((connection) => resolveNetworkConnectionOwners(connection, index));
    const allRows = rows.map((connection) =>
      resolveNetworkConnectionOwners(connection, index),
    );

    expect(index.size).toBe(250);
    expect(firstPage).toHaveLength(100);
    expect(allRows).toHaveLength(500);
    expect(allRows[0]?.processes).toHaveLength(1);
    expect(allRows.some(({ unavailablePids }) => unavailablePids.length === 1)).toBe(
      true,
    );
  });
});

function historyPoint(
  timestamp: number,
  received: number | null,
  transmitted: number | null,
): HistoryPoint {
  return {
    timestamp,
    cpuPercent: 10,
    memoryPercent: 20,
    diskReadBytesPerSecond: 30,
    diskWriteBytesPerSecond: 40,
    networkReceivedBytesPerSecond: received,
    networkTransmittedBytesPerSecond: transmitted,
  };
}

describe("network interfaces", () => {
  it("combines one-sided rates and keeps unavailable rates distinct", () => {
    expect(networkInterfaceRate(interfaceFixture("en0", 500, null))).toBe(500);
    expect(networkInterfaceRate(interfaceFixture("en1", null, null))).toBeNull();
  });

  it("sorts by current traffic, then state, session traffic, and name", () => {
    const fast = interfaceFixture("en0", 800, 200);
    const quietUp = interfaceFixture("en1", 0, 0, {
      receivedBytesSinceLaunch: 20,
    });
    const quietDown = interfaceFixture("en2", 0, 0, {
      receivedBytesSinceLaunch: 500,
      operationalState: "down",
    });

    expect(
      sortNetworkInterfaces([quietDown, quietUp, fast]).map(({ name }) => name),
    ).toEqual(["en0", "en1", "en2"]);
  });

  it("collapses never-used interfaces and can reveal every interface", () => {
    const active = interfaceFixture("en0", 100, 20);
    const loopback = interfaceFixture("lo0", 0, 0);
    const down = interfaceFixture("awdl0", 0, 0, {
      operationalState: "down",
    });

    expect(visibleNetworkInterfaces([loopback, down, active], false)).toMatchObject({
      interfaces: [active],
      hiddenCount: 2,
    });
    expect(
      visibleNetworkInterfaces([loopback, down, active], true).interfaces.map(
        ({ name }) => name,
      ),
    ).toEqual(["en0", "lo0", "awdl0"]);
  });

  it("shows up interfaces while the first traffic baseline is warming", () => {
    const up = interfaceFixture("en0", null, null);
    const down = interfaceFixture("en1", null, null, {
      operationalState: "down",
    });

    expect(visibleNetworkInterfaces([down, up], false)).toMatchObject({
      interfaces: [up],
      hiddenCount: 1,
    });
  });
});

describe("network history", () => {
  it("sorts samples and keeps the latest five-minute window", () => {
    const latest = NETWORK_HISTORY_WINDOW_MS + 2_000;
    const result = networkHistoryWindow([
      historyPoint(latest, 3, 3),
      historyPoint(1_000, 1, 1),
      historyPoint(2_000, 2, 2),
    ]);

    expect(result.map((point) => point.timestamp)).toEqual([2_000, latest]);
  });

  it("breaks receive and transmit series at null values and long gaps", () => {
    const history = [
      historyPoint(0, 10, 10),
      historyPoint(1_000, 20, null),
      historyPoint(2_000, null, 30),
      historyPoint(8_000, 40, 40),
    ];

    expect(
      networkHistorySegments(history, "received").map((segment) =>
        segment.map(({ value }) => value),
      ),
    ).toEqual([[10, 20], [40]]);
    expect(
      networkHistorySegments(history, "transmitted").map((segment) =>
        segment.map(({ value }) => value),
      ),
    ).toEqual([[10], [30], [40]]);
  });
});
