import {
  SNAPSHOT_SCHEMA_VERSION,
  type ProcessActionRequest,
  type ProcessActionResult,
  type ProcessDetail,
  type ProcessDetailRequest,
  type ProcessRow,
  type SystemSnapshot,
} from "./types";

let sequence = 0;
const launchedAt = Date.now();
const startTime = Math.floor(launchedAt / 1_000) - 12_300;

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
    pid: 932,
    birthToken: `mock:932:${startTime - 2_000}`,
    parentPid: 1,
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
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    protected: true,
  },
];

export function getMockSnapshot(): SystemSnapshot {
  sequence += 1;
  const phase = sequence / 4;
  const cpu = Math.max(8, 42 + Math.sin(phase) * 18);
  const memoryUsed = 12_884_901_888 + Math.sin(phase / 2) * 320_000_000;
  const warmingUp = sequence === 1;

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
      receivedBytesPerSecond: warmingUp ? null : 4_100_000,
      transmittedBytesPerSecond: warmingUp ? null : 890_000,
      interfaceCount: 7,
    },
    processes: baseProcesses.map((process, index) => ({
      ...process,
      cpuPercent:
        process.cpuPercent === null
          ? null
          : Math.max(0, process.cpuPercent + Math.sin(phase + index) * 4),
      runTimeSeconds: process.runTimeSeconds + sequence,
    })),
    capabilities: {
      platform: "macos",
      requestClose: true,
      forceKill: true,
      requiresConfirmation: true,
    },
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

export function executeMockProcessAction(
  request: ProcessActionRequest,
): ProcessActionResult {
  return {
    signalSent: true,
    outcome: "signal_sent",
    message:
      request.action === "request_close"
        ? "已发送结束请求，正在等待进程退出。"
        : "已发送强制结束请求，正在等待进程退出。",
  };
}
