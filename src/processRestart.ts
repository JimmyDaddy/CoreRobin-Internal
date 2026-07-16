import type { SystemSnapshot } from "./types";
import { processIdentity } from "./utils";

interface ProcessExitWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForProcessIdentityExit(
  identity: string,
  sample: () => Promise<SystemSnapshot>,
  options: ProcessExitWaitOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const intervalMs = Math.max(50, options.intervalMs ?? 400);
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  }));
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const snapshot = await sample();
      if (!snapshot.processes.some((process) => processIdentity(process) === identity)) {
        return true;
      }
    } catch {
      return false;
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }

  return false;
}
