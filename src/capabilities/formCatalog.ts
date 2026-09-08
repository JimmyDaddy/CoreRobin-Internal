import { TOOLBOX_TOOL_IDS, type ToolId } from "../toolbox/contracts";
export const BUSINESS_FORM_IDS = [
  "processes.usage",
  "processes.control",
  "network.quality",
  "storage.scan",
  "storage.cleanup",

  "device.status", "device.gpu_energy", "network.connections", "storage.volumes", "storage.eject",
  "storage.file_insights", "applications.activity", "applications.manage", "startup.manage",
  "history.records", "history.export", "diagnosis.incidents", "settings.privacy",
] as const;
export type BusinessFormId = typeof BUSINESS_FORM_IDS[number];
export type CapabilityFormId = BusinessFormId | "storage.quick_clean" | `toolbox.${ToolId}`;
export function isBusinessFormId(value: unknown): value is BusinessFormId {
  return typeof value === "string" && (BUSINESS_FORM_IDS as readonly string[]).includes(value);
}
export function isCapabilityFormId(value: unknown): value is CapabilityFormId {
  return typeof value === "string" && (isBusinessFormId(value) || value === "storage.quick_clean" || value.startsWith("toolbox.") && (TOOLBOX_TOOL_IDS as readonly string[]).includes(value.slice(8)));
}

export const BUSINESS_FORM_TITLE_KEYS = {
  "processes.usage": "businessTitles.processes_usage",
  "processes.control": "businessTitles.processes_control",
  "network.quality": "businessTitles.network_quality",
  "storage.scan": "businessTitles.storage_scan",
  "storage.cleanup": "businessTitles.storage_cleanup",

  "device.status": "businessTitles.device_status",
  "device.gpu_energy": "businessTitles.device_gpu_energy",
  "network.connections": "businessTitles.network_connections",
  "storage.volumes": "businessTitles.storage_volumes",
  "storage.eject": "businessTitles.storage_eject",
  "storage.file_insights": "businessTitles.storage_file_insights",
  "applications.activity": "businessTitles.applications_activity",
  "applications.manage": "businessTitles.applications_manage",
  "startup.manage": "businessTitles.startup_manage",
  "history.records": "businessTitles.history_records",
  "history.export": "businessTitles.history_export",
  "diagnosis.incidents": "businessTitles.diagnosis_incidents",
  "settings.privacy": "businessTitles.settings_privacy",
} as const;
