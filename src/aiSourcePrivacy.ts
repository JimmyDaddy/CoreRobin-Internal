import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./api";

export type AiSourceCategory = "resourceHistory" | "connectionHistory" | "applicationInventory" | "scanCaches" | "networkQuality" | "connections" | "userActions";

export async function settleSourceRemovals(removals: ReadonlyArray<() => Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(removals.map(async (remove) => remove()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/** Keep all views from preparing old source data across a multi-store removal. */
export async function withAiSourceClear<T>(category: AiSourceCategory, deleteRelated: boolean, clear: () => Promise<T>): Promise<T> {
  const token = isDesktopRuntime()
    ? await invoke<number>("ai_invalidate_source", {category, deleteRelated})
    : null;
  try { return await clear(); }
  finally { if (token !== null) await invoke("ai_finish_source_clear", {token}); }
}
