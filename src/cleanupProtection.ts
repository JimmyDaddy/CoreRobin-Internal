import type { CleanupNode, CleanupProtectionReason } from "./types";

const LEGACY_VIEW_ONLY_PROFILE_ROOTS = new Set([
  "library",
  "appdata",
  "applications",
]);

export function cleanupNodeProtection(node: CleanupNode): CleanupProtectionReason | null {
  if (node.protectionReason) return node.protectionReason;
  if (node.kind === "restricted") return "restricted";
  if (node.kind === "aggregate" || node.path === null) return "aggregate";
  if (node.deletionProtected) return "sensitive_user_data";
  if (Object.prototype.hasOwnProperty.call(node, "protectionReason")) return null;

  const path = normalizeCleanupPath(node.path);
  if (path === "~") return "home_root";
  if (isTemporaryRootPath(path)) return "system_location";
  if (!path.startsWith("~/")) return "system_location";
  if (isTrashRootPath(path)) return "trash_root";
  if (isInsideTrashPath(path)) return null;
  return legacyStructuralProtection(path);
}

export function canCollectCleanupNode(node: CleanupNode): boolean {
  return (node.kind === "folder" || node.kind === "file") &&
    cleanupNodeProtection(node) === null;
}

export function isTrashRootPath(path: string | null): boolean {
  if (!path) return false;
  const normalized = normalizeCleanupPath(path);
  return normalized === "~/.trash" ||
    normalized.endsWith("/.trash") ||
    normalized === "~/.local/share/trash/files" ||
    normalized.endsWith("/.local/share/trash/files");
}

export function isInsideTrashPath(path: string | null): boolean {
  if (!path) return false;
  const normalized = normalizeCleanupPath(path);
  return normalized.startsWith("~/.trash/") ||
    normalized.includes("/.trash/") ||
    normalized.startsWith("~/.local/share/trash/files/");
}

function legacyStructuralProtection(path: string): CleanupProtectionReason | null {
  const relative = path.slice(2);
  if (relative === "system" || relative.startsWith("system/")) return "sensitive_user_data";
  return !relative.includes("/") && LEGACY_VIEW_ONLY_PROFILE_ROOTS.has(relative)
    ? "sensitive_user_data"
    : null;
}

function isTemporaryRootPath(path: string): boolean {
  return path === "/tmp" || path === "/private/tmp" ||
    path === "/var/tmp" || path === "/private/var/tmp";
}

function normalizeCleanupPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}
