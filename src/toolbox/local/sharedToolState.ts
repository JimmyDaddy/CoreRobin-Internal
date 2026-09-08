import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { ToolId } from "../contracts";

interface Entry { snapshot: { value: unknown; epoch: number }; initial: unknown; listeners: Set<() => void>; touched: number }
const entries = new Map<string, Entry>();
let epoch = 0;
const revisions = new Map<ToolId, number>();
const RETAINED_BYTES = 8 * 1024 * 1024;
const size = (value: unknown): number => { try { return JSON.stringify(value)?.length ?? 0; } catch { return RETAINED_BYTES + 1; } };
function trim() {
  const inactive = [...entries].filter(([, entry]) => entry.listeners.size === 0).sort((a, b) => a[1].touched - b[1].touched);
  let bytes = inactive.reduce((total, [, entry]) => total + size(entry.snapshot.value), 0);
  for (const [key, entry] of inactive) { if (bytes <= RETAINED_BYTES) break; bytes -= size(entry.snapshot.value); entries.delete(key); }
}
function getEntry(key: string, initial: unknown | (() => unknown)): Entry {
  const existing = entries.get(key); if (existing) return existing;
  const value = typeof initial === "function" ? initial() : initial;
  const entry = { snapshot: { value, epoch }, initial: value, listeners: new Set<() => void>(), touched: Date.now() };
  entries.set(key, entry); return entry;
}

/** Only text-tool state, in this WebView's memory. Never use for credentials,
 * Wi-Fi secrets, file bytes, or image-watermark keys. Pages and cards use the
 * same fields; native file tools continue using their existing job/token store. */
export function useSharedToolState<T>(toolId: ToolId, field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const key = `${toolId}:${field}`;
  const entry = getEntry(key, initial);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); trim(); };
  }, [entry]);
  const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot);
  const setValue: Dispatch<SetStateAction<T>> = useCallback((value) => {
    // A late digest/worker result cannot restore text removed by Clear Data.
    if (snapshot.epoch !== epoch) return;
    const next = typeof value === "function" ? (value as (current: T) => T)(entry.snapshot.value as T) : value;
    entry.snapshot = { value: next, epoch }; entry.touched = Date.now();
    revisions.set(toolId, (revisions.get(toolId) ?? 0) + 1);
    for (const listener of entry.listeners) listener();
  }, [entry, snapshot.epoch, toolId]);
  return [snapshot.value as T, setValue];
}

export function clearSharedToolState() {
  ++epoch;
  for (const [key, entry] of entries) {
    if (entry.listeners.size === 0) { entries.delete(key); continue; }
    entry.snapshot = { value: entry.initial, epoch };
    for (const listener of entry.listeners) listener();
  }
}

export function currentToolStateEpoch() { return epoch; }
export function captureToolStateVersion(toolId: ToolId) { return { epoch, revision: revisions.get(toolId) ?? 0 }; }
/** Capture versions, not values, before an asynchronous claim identifies its tool. */
export function captureToolStateVersions() {
  const capturedEpoch = epoch;
  const capturedRevisions = new Map(revisions);
  return (toolId: ToolId) => ({ epoch: capturedEpoch, revision: capturedRevisions.get(toolId) ?? 0 });
}
const DEFAULTS: Record<string, Record<string, unknown>> = {
  "qr-code": { text: "", image: "" },
  json: { input: "", indent: 2, output: "", error: "", duplicates: [] },
  url: { input: "", mode: "inspect", output: "", error: "" },
  base64: { input: "", urlSafe: false, decode: false, output: "", error: "" },
  time: { input: "", unit: "seconds", output: "", error: "" },
  uuid: { count: "1", output: "", error: "" },
  "text-sha256": { input: "", expectedDigest: "", output: "", error: "" },
  regex: { pattern: "(?<word>\\w+)", flags: "gu", sample: "CoreRobin 工具箱", replacement: "[$<word>]", analysis: null, result: "", error: "" },
  color: { input: "#f15a43", output: null, error: "" },
};
/** Publish only a fixed utility's explicit result; never read existing input for AI. */
export function publishToolValues(toolId: ToolId, fields: Record<string, unknown>, expected: ReturnType<typeof captureToolStateVersion>): boolean {
  if (expected.epoch !== epoch || expected.revision !== (revisions.get(toolId) ?? 0)) return false;
  const defaults = DEFAULTS[toolId];
  if (!defaults || Object.keys(fields).some((field) => !(field in defaults))) return false;
  const listeners = new Set<() => void>();
  for (const [field, value] of Object.entries(fields)) {
    const entry = getEntry(`${toolId}:${field}`, defaults[field]);
    entry.snapshot = { value, epoch }; entry.touched = Date.now();
    for (const listener of entry.listeners) listeners.add(listener);
  }
  revisions.set(toolId, expected.revision + 1);
  for (const listener of listeners) listener();
  trim(); return true;
}
