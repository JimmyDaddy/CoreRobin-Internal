import type {
  ApplicationIconRequest,
  ProcessRow,
  StartupItem,
} from "./types";

export function processApplicationIconSource(
  process: Pick<ProcessRow, "pid" | "startTime" | "birthToken">,
): ApplicationIconRequest {
  return {
    process: {
      pid: process.pid,
      snapshotStartTime: process.startTime,
      snapshotBirthToken: process.birthToken,
    },
  };
}

export function startupApplicationIconSource(
  item: Pick<StartupItem, "command">,
): ApplicationIconRequest | null {
  const executablePath = item.command?.trim();
  return executablePath ? { executablePath } : null;
}
