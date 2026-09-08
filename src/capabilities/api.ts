import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NetworkQualityResult } from "../types";

export type ApplicationCapability = "disk" | "network" | "quick_clean";
export interface ApplicationCapabilityState {
  diskRevision: number;
  diskRequiresRescan: boolean;
  networkRevision: number;
  network: NetworkQualityResult | null;
}
export const APPLICATION_CAPABILITY_EVENT = "core-robin:application-capability-changed";
export const readApplicationCapabilities = () =>
  invoke<ApplicationCapabilityState>("get_application_capability_state");
export const subscribeApplicationCapabilities = (onChange: (capability: ApplicationCapability) => void) =>
  listen<string>(APPLICATION_CAPABILITY_EVENT, ({ payload }) => {
    if (payload === "disk" || payload === "network" || payload === "quick_clean") onChange(payload);
  });
