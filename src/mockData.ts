import {
  SNAPSHOT_SCHEMA_VERSION,
  type ProcessActionRequest,
  type ProcessActionResult,
  type ProcessControlLease,
  type ProcessControlLeaseReleaseRequest,
  type ProcessControlLeaseRequest,
  type ProcessDetail,
  type ProcessDetailRequest,
  type NetworkConnection,
  type NetworkConnectionsSnapshot,
  type ProcessRow,
  type SystemSnapshot,
} from "./types";

let sequence = 0;
let leaseSequence = 0;
const mockLeases = new Map<string, ProcessControlLease>();
// Keep demo identities stable across browser reloads so view preferences can be
// exercised without implying that a reused PID is the same process.
const startTime = 1_750_000_000;

const mockConnections: NetworkConnection[] = [
  {
    protocol: "tcp",
    addressFamily: "ipv4",
    localEndpoint: { address: "192.168.1.42", port: 51_234 },
    remoteEndpoint: { address: "203.0.113.24", port: 443 },
    state: "established",
  },
  {
    protocol: "tcp",
    addressFamily: "ipv6",
    localEndpoint: { address: "2001:db8::42", port: 51_882 },
    remoteEndpoint: { address: "2001:db8:2::80", port: 443 },
    state: "established",
  },
  {
    protocol: "tcp",
    addressFamily: "ipv4",
    localEndpoint: { address: "127.0.0.1", port: 1_420 },
    remoteEndpoint: null,
    state: "listen",
  },
  {
    protocol: "tcp",
    addressFamily: "ipv4",
    localEndpoint: { address: "0.0.0.0", port: 22 },
    remoteEndpoint: null,
    state: "listen",
  },
  {
    protocol: "tcp",
    addressFamily: "ipv4",
    localEndpoint: { address: "192.168.1.42", port: 50_910 },
    remoteEndpoint: { address: "198.51.100.18", port: 443 },
    state: "time_wait",
  },
  {
    protocol: "tcp",
    addressFamily: "ipv4",
    localEndpoint: { address: "192.168.1.42", port: 50_422 },
    remoteEndpoint: { address: "203.0.113.82", port: 22 },
    state: "close_wait",
  },
  {
    protocol: "udp",
    addressFamily: "ipv4",
    localEndpoint: { address: "0.0.0.0", port: 5_353 },
    remoteEndpoint: null,
    state: "unconnected",
  },
  {
    protocol: "udp",
    addressFamily: "ipv6",
    localEndpoint: { address: "::", port: 5_353 },
    remoteEndpoint: null,
    state: "unconnected",
  },
];

const baseProcesses: ProcessRow[] = [
  {
    pid: 48_102,
    birthToken: `mock:48102:${startTime}`,
    parentPid: 48_000,
    startTime,
    runTimeSeconds: 7_200,
    name: "node",
    user: "developer",
    status: "Run",
    cpuPercent: 187,
    memoryBytes: 1_503_238_553,
    diskReadBytesPerSecond: 1_900_000,
    diskWriteBytesPerSecond: 8_400_000,
    protected: false,
  },
  {
    pid: 48_000,
    birthToken: `mock:48000:${startTime - 1_000}`,
    parentPid: 1,
    startTime: startTime - 1_000,
    runTimeSeconds: 8_200,
    name: "Terminal",
    user: "developer",
    status: "Sleep",
    cpuPercent: 3.8,
    memoryBytes: 162_529_280,
    diskReadBytesPerSecond: 34_000,
    diskWriteBytesPerSecond: 18_000,
    protected: false,
  },
  {
    pid: 932,
    birthToken: `mock:932:${startTime - 2_000}`,
    parentPid: 99_999,
    startTime: startTime - 2_000,
    runTimeSeconds: 9_200,
    name: "Docker Desktop",
    user: "developer",
    status: "Run",
    cpuPercent: 63,
    memoryBytes: 4_080_218_931,
    diskReadBytesPerSecond: 8_300_000,
    diskWriteBytesPerSecond: 14_100_000,
    protected: false,
  },
  {
    pid: 388,
    birthToken: `mock:388:${startTime - 80_000}`,
    parentPid: 1,
    startTime: startTime - 80_000,
    runTimeSeconds: 91_000,
    name: "WindowServer",
    user: "_windowserver",
    status: "Run",
    cpuPercent: 28,
    memoryBytes: 754_974_720,
    diskReadBytesPerSecond: 21_000,
    diskWriteBytesPerSecond: 0,
    protected: false,
  },
  {
    pid: 46_177,
    birthToken: `mock:46177:${startTime - 400}`,
    parentPid: 46_100,
    startTime: startTime - 400,
    runTimeSeconds: 4_900,
    name: "Code Helper",
    user: "developer",
    status: "Sleep",
    cpuPercent: 17,
    memoryBytes: 1_181_116_006,
    diskReadBytesPerSecond: 190_000,
    diskWriteBytesPerSecond: 96_000,
    protected: false,
  },
  {
    pid: 46_100,
    birthToken: `mock:46100:${startTime - 800}`,
    parentPid: 1,
    startTime: startTime - 800,
    runTimeSeconds: 5_300,
    name: "Code",
    user: "developer",
    status: "Sleep",
    cpuPercent: 8.4,
    memoryBytes: 536_870_912,
    diskReadBytesPerSecond: 104_000,
    diskWriteBytesPerSecond: 220_000,
    protected: false,
  },
  {
    pid: 1,
    birthToken: `mock:1:${startTime - 200_000}`,
    parentPid: null,
    startTime: startTime - 200_000,
    runTimeSeconds: 240_000,
    name: "launchd",
    user: "root",
    status: "Sleep",
    cpuPercent: 0.2,
    memoryBytes: 26_214_400,
    diskReadBytesPerSecond: 2_400,
    diskWriteBytesPerSecond: 1_200,
    protected: true,
  },
];

export function getMockSnapshot(): SystemSnapshot {
  sequence += 1;
  const phase = sequence / 4;
  const cpu = Math.max(8, 42 + Math.sin(phase) * 18);
  const memoryUsed = 12_884_901_888 + Math.sin(phase / 2) * 320_000_000;
  const warmingUp = sequence === 1;
  const primaryReceived = Math.round(3_400_000 * (1 + Math.sin(phase + 0.4) * 0.18));
  const primaryTransmitted = Math.round(700_000 * (1 + Math.sin(phase + 1.1) * 0.16));
  const vpnReceived = Math.round(700_000 * (1 + Math.sin(phase + 1.7) * 0.22));
  const vpnTransmitted = Math.round(190_000 * (1 + Math.sin(phase + 2.2) * 0.2));
  const networkInterfaces = [
    {
      name: "en0",
      receivedBytesPerSecond: warmingUp ? null : primaryReceived,
      transmittedBytesPerSecond: warmingUp ? null : primaryTransmitted,
      receivedBytesSinceLaunch: sequence * 3_400_000,
      transmittedBytesSinceLaunch: sequence * 700_000,
      packetsReceivedSinceLaunch: sequence * 2_850,
      packetsTransmittedSinceLaunch: sequence * 910,
      receiveErrorsSinceLaunch: 0,
      transmitErrorsSinceLaunch: 0,
      mtu: 1_500,
      macAddress: "a0:b1:c2:d3:e4:f5",
      ipNetworks: ["192.168.1.42/24", "fe80::42/64"],
      operationalState: "up" as const,
    },
    {
      name: "utun6",
      receivedBytesPerSecond: warmingUp ? null : vpnReceived,
      transmittedBytesPerSecond: warmingUp ? null : vpnTransmitted,
      receivedBytesSinceLaunch: sequence * 700_000,
      transmittedBytesSinceLaunch: sequence * 190_000,
      packetsReceivedSinceLaunch: sequence * 620,
      packetsTransmittedSinceLaunch: sequence * 210,
      receiveErrorsSinceLaunch: 1,
      transmitErrorsSinceLaunch: 0,
      mtu: 1_380,
      macAddress: null,
      ipNetworks: ["10.8.0.2/32"],
      operationalState: "up" as const,
    },
    {
      name: "lo0",
      receivedBytesPerSecond: warmingUp ? null : 0,
      transmittedBytesPerSecond: warmingUp ? null : 0,
      receivedBytesSinceLaunch: 0,
      transmittedBytesSinceLaunch: 0,
      packetsReceivedSinceLaunch: 0,
      packetsTransmittedSinceLaunch: 0,
      receiveErrorsSinceLaunch: 0,
      transmitErrorsSinceLaunch: 0,
      mtu: 16_384,
      macAddress: null,
      ipNetworks: ["127.0.0.1/8", "::1/128"],
      operationalState: "up" as const,
    },
    {
      name: "awdl0",
      receivedBytesPerSecond: warmingUp ? null : 0,
      transmittedBytesPerSecond: warmingUp ? null : 0,
      receivedBytesSinceLaunch: 0,
      transmittedBytesSinceLaunch: 0,
      packetsReceivedSinceLaunch: 0,
      packetsTransmittedSinceLaunch: 0,
      receiveErrorsSinceLaunch: 0,
      transmitErrorsSinceLaunch: 0,
      mtu: 1_484,
      macAddress: "02:00:00:00:00:00",
      ipNetworks: [],
      operationalState: "down" as const,
    },
  ];

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sequence,
    sampledAtMs: Date.now(),
    sampleIntervalMs: 1_000,
    warmingUp,
    host: {
      hostname: "Demo MacBook Pro",
      osName: "macOS",
      osVersion: "26.0",
      kernelVersion: "25.0.0",
      architecture: "arm64",
      cpuName: "Apple M4 Pro",
    },
    cpu: {
      usagePercent: warmingUp ? null : cpu,
      perCorePercent: [32, 48, 61, 27, 46, 39, 72, 18],
      logicalCoreCount: 8,
    },
    memory: {
      totalBytes: 19_327_352_832,
      usedBytes: memoryUsed,
      availableBytes: 19_327_352_832 - memoryUsed,
      swapTotalBytes: 4_294_967_296,
      swapUsedBytes: 402_653_184,
    },
    disk: {
      readBytesPerSecond: warmingUp ? null : 8_300_000,
      writeBytesPerSecond: warmingUp ? null : 31_200_000,
      volumes: [
        {
          name: "Macintosh HD",
          mountPoint: "/",
          totalBytes: 1_000_204_886_016,
          availableBytes: 487_203_110_912,
          removable: false,
        },
      ],
    },
    network: {
      receivedBytesPerSecond: warmingUp
        ? null
        : primaryReceived + vpnReceived,
      transmittedBytesPerSecond: warmingUp
        ? null
        : primaryTransmitted + vpnTransmitted,
      receivedBytesSinceLaunch: networkInterfaces.reduce(
        (total, networkInterface) =>
          total + networkInterface.receivedBytesSinceLaunch,
        0,
      ),
      transmittedBytesSinceLaunch: networkInterfaces.reduce(
        (total, networkInterface) =>
          total + networkInterface.transmittedBytesSinceLaunch,
        0,
      ),
      interfaceCount: networkInterfaces.length,
      interfaces: networkInterfaces,
    },
    processes: baseProcesses.map((process, index) => {
      const resourcePhase = phase + index * 0.73;
      const fluctuateRate = (value: number | null, offset: number): number | null => {
        if (warmingUp || value === null) return null;
        return Math.max(
          0,
          Math.round(value * (1 + Math.sin(resourcePhase + offset) * 0.08)),
        );
      };

      return {
        ...process,
        cpuPercent:
          process.cpuPercent === null
            ? null
            : Math.max(0, process.cpuPercent + Math.sin(resourcePhase) * 4),
        memoryBytes: Math.max(
          0,
          Math.round(process.memoryBytes * (1 + Math.sin(resourcePhase + 0.35) * 0.012)),
        ),
        diskReadBytesPerSecond: fluctuateRate(process.diskReadBytesPerSecond, 0.7),
        diskWriteBytesPerSecond: fluctuateRate(process.diskWriteBytesPerSecond, 1.4),
        runTimeSeconds: process.runTimeSeconds + sequence,
      };
    }),
    capabilities: {
      platform: "macos",
      processControl: {
        targeting: "best_effort_pid",
        requestClose: {
          enabled: true,
          semantic: "sigterm",
          disabledReason: null,
        },
        forceKill: {
          enabled: true,
          semantic: "sigkill",
          disabledReason: null,
        },
        leaseTtlMs: 60_000,
      },
      requiresConfirmation: true,
    },
  };
}

export function getMockNetworkConnections(): NetworkConnectionsSnapshot {
  return {
    sampledAtMs: Date.now(),
    summary: {
      totalCount: mockConnections.length,
      tcpCount: mockConnections.filter(({ protocol }) => protocol === "tcp").length,
      udpCount: mockConnections.filter(({ protocol }) => protocol === "udp").length,
      establishedCount: mockConnections.filter(
        ({ state }) => state === "established",
      ).length,
      listeningCount: mockConnections.filter(({ state }) => state === "listen").length,
    },
    connections: mockConnections,
    truncated: false,
    skippedEntryCount: 0,
  };
}

export function getMockProcessDetail(request: ProcessDetailRequest): ProcessDetail {
  const process = baseProcesses.find(
    (candidate) =>
      candidate.pid === request.pid &&
      candidate.startTime === request.snapshotStartTime &&
      candidate.birthToken === request.snapshotBirthToken,
  );
  if (!process) {
    throw { code: "process_exited", message: "进程已经退出。" };
  }

  const protectedReason = process.protected ? "这是受保护的系统进程。" : null;
  const birthToken = process.birthToken;
  const hasVerifiableIdentity = birthToken !== null;
  return {
    key: process.protected || birthToken === null
      ? null
      : { pid: process.pid, birthToken },
    pid: process.pid,
    parentPid: process.parentPid,
    startTime: process.startTime,
    runTimeSeconds: process.runTimeSeconds,
    name: process.name,
    user: process.user,
    status: process.status,
    cpuPercent: process.cpuPercent,
    memoryBytes: process.memoryBytes,
    virtualMemoryBytes: process.memoryBytes * 2.3,
    executable:
      process.name === "node"
        ? "/opt/homebrew/bin/node"
        : `/Applications/${process.name}.app/Contents/MacOS/${process.name}`,
    commandLine: process.name === "node" ? "node ./scripts/build.mjs --watch" : process.name,
    canTerminate: !process.protected && hasVerifiableIdentity,
    protectedReason,
    identityError: hasVerifiableIdentity ? null : "无法核验该进程的高精度身份。",
  };
}

export function createMockProcessControlLease(
  request: ProcessControlLeaseRequest,
): ProcessControlLease {
  if (!request.acknowledgeBestEffort) {
    throw {
      code: "best_effort_confirmation_required",
      message: "请先确认 macOS 的 best-effort PID 定位限制。",
    };
  }
  const process = baseProcesses.find(
    (candidate) =>
      candidate.pid === request.key.pid &&
      candidate.birthToken === request.key.birthToken,
  );
  if (!process) {
    throw { code: "stale_process", message: "进程身份已经变化。" };
  }

  leaseSequence += 1;
  const lease: ProcessControlLease = {
    id: `mock-lease-${leaseSequence}`,
    key: request.key,
    action: request.action,
    targeting: "best_effort_pid",
    expiresAtMs: Date.now() + 60_000,
  };
  mockLeases.set(lease.id, lease);
  return lease;
}

export function releaseMockProcessControlLease(
  request: ProcessControlLeaseReleaseRequest,
): void {
  mockLeases.delete(request.leaseId);
}

export function executeMockProcessAction(
  request: ProcessActionRequest,
): ProcessActionResult {
  const lease = mockLeases.get(request.leaseId);
  mockLeases.delete(request.leaseId);
  if (!lease) {
    throw {
      code: "control_lease_unavailable",
      message: "本次进程确认已经使用或取消。",
    };
  }
  if (
    lease.expiresAtMs <= Date.now() ||
    lease.action !== request.action ||
    lease.key.pid !== request.key.pid ||
    lease.key.birthToken !== request.key.birthToken
  ) {
    throw {
      code: "control_lease_mismatch",
      message: "进程确认与当前操作不匹配，未发送信号。",
    };
  }
  return {
    signalSent: true,
    outcome: "still_running",
    message:
      request.action === "request_close"
        ? "已发送结束请求，正在等待进程退出。"
        : "已发送强制结束请求，正在等待进程退出。",
  };
}
