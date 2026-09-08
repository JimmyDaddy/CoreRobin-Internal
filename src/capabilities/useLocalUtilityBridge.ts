import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isDesktopRuntime } from "../api";
import { createAsyncListenerRegistry } from "../asyncListener";
import { captureToolStateVersions, currentToolStateEpoch, publishToolValues } from "../toolbox/local/sharedToolState";
import type { UtilityArguments } from "../toolbox/local/utilityOperations";

/** Mounted only in the main App; the bubble has neither this executor nor its ACL. */
export function useLocalUtilityBridge() {
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const listeners = createAsyncListenerRegistry();
    const working = new Set<string>();
    const run = async (nonce: string) => {
      if (listeners.disposed || working.has(nonce) || working.size >= 8 || typeof nonce !== "string" || nonce.length > 128) return;
      working.add(nonce);
      try {
        const startedEpoch = currentToolStateEpoch();
        const versionAtStart = captureToolStateVersions();
        const args = await invoke<UtilityArguments>("ai_claim_utility_request", { nonce });
        if (listeners.disposed) return;
        const { utilityToolId, executeTextUtility, utilityExcerpt } = await import("../toolbox/local/utilityOperations");
        if (startedEpoch !== currentToolStateEpoch()) throw { code: "cancelled" };
        const toolId = utilityToolId(args);
        const version = versionAtStart(toolId);
        const result = await executeTextUtility(args);
        if (listeners.disposed) return;
        await invoke("ai_complete_utility_request", { nonce, reply: { ...utilityExcerpt(result.output), errorCode: null } });
        if (!listeners.disposed) publishToolValues(toolId, result.fields, version);
      } catch (reason) {
        if (listeners.disposed) return;
        const code = reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string" && /^[a-z_]{1,64}$/.test(reason.code) ? reason.code : "local_utility_failed";
        // An expired/duplicate claim cannot complete another operation. Error
        // messages or local values are never included in this failure receipt.
        await invoke("ai_complete_utility_request", { nonce, reply: { output: null, truncated: false, errorCode: code } }).catch(() => {});
      } finally { working.delete(nonce); }
    };
    const registration = listen<string>("core-robin:local-utility-request", ({ payload }) => { void run(payload); });
    listeners.register(registration);
    // Subscribe before recovering a request emitted while the main view mounted.
    void registration.then(() => listeners.disposed ? [] : invoke<string[]>("ai_pending_utility_requests")).then((nonces) => { for (const nonce of nonces) void run(nonce); }).catch(() => {});
    return () => listeners.dispose();
  }, []);
}
