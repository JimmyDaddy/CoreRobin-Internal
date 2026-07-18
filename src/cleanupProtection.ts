import type { CleanupNode, CleanupProtectionReason } from "./types";

const REGENERATABLE_ROOTS = [
  ".cache",
  ".pnpm-store",
  ".cargo/registry",
  ".cargo/git",
  ".npm/_cacache",
  ".yarn/berry/cache",
  ".gradle/caches",
  ".m2/repository",
  ".bun/install/cache",
  ".rustup/downloads",
  ".rustup/tmp",
  ".local/share/pnpm/store",
  "library/caches",
  "library/developer/xcode/deriveddata",
  "library/pnpm/store",
  "appdata/local/temp",
  "appdata/local/pnpm/store",
] as const;

const SENSITIVE_PROFILE_ROOTS = new Set([
  "library",
  "appdata",
  "applications",
  "system",
  "ntuser.dat",
  "ntuser.dat.log1",
  "ntuser.dat.log2",
  "ntuser.ini",
]);

export function cleanupNodeProtection(node: CleanupNode): CleanupProtectionReason | null {
  if (node.protectionReason) return node.protectionReason;
  if (node.kind === "restricted") return "restricted";
  if (node.kind === "aggregate" || node.path === null) return "aggregate";
  if (node.deletionProtected) return "sensitive_user_data";

  const path = normalizeCleanupPath(node.path);
  if (path === "~") return "home_root";
  if (!path.startsWith("~/")) return "system_location";
  if (isTrashRootPath(path)) return "trash_root";
  if (isInsideTrashPath(path)) return null;
  return isSensitiveUserPath(path) ? "sensitive_user_data" : null;
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

function isSensitiveUserPath(path: string): boolean {
  const relative = path.slice(2);
  if (REGENERATABLE_ROOTS.some((root) => relative === root || relative.startsWith(`${root}/`))) {
    return false;
  }
  const first = relative.split("/", 1)[0];
  return first.startsWith(".") || SENSITIVE_PROFILE_ROOTS.has(first);
}

function normalizeCleanupPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}
