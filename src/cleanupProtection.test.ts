import { describe, expect, it } from "vitest";

import {
  canCollectCleanupNode,
  cleanupNodeProtection,
} from "./cleanupProtection";
import type { CleanupNode } from "./types";

describe("cleanup deletion protection", () => {
  it.each([
    ["/System/Library", "system_location"],
    ["/tmp", "system_location"],
    ["/private/var/tmp", "system_location"],
    ["~", "home_root"],
    ["~/.Trash", "trash_root"],
    ["~/Library/Preferences/example.plist", "sensitive_user_data"],
    ["~/.ssh/id_ed25519", "sensitive_user_data"],
    ["~/AppData/Roaming/example/settings.json", "sensitive_user_data"],
  ] as const)("protects %s as %s", (path, reason) => {
    const node = cleanupNode(path);
    expect(cleanupNodeProtection(node)).toBe(reason);
    expect(canCollectCleanupNode(node)).toBe(false);
  });

  it.each([
    "~/Downloads/archive.zip",
    "~/Library/Caches/example/cache.bin",
    "~/Library/Logs/example.log",
    "~/Library/Containers/com.example.App/Data/tmp/session.bin",
    "~/Library/Containers/com.example.App/Data/Library/Caches/cache.bin",
    "~/Library/Group Containers/group.example/Library/Caches/cache.bin",
    "~/.cargo/registry/cache.bin",
    "~/.Trash/old.txt",
  ])("keeps explicitly cleanable content available: %s", (path) => {
    const node = cleanupNode(path);
    expect(cleanupNodeProtection(node)).toBeNull();
    expect(canCollectCleanupNode(node)).toBe(true);
  });

  it("trusts an explicit backend protection marker over a cleanable-looking path", () => {
    const node = cleanupNode("~/Downloads/managed.data");
    node.deletionProtected = true;
    node.protectionReason = "sensitive_user_data";
    expect(cleanupNodeProtection(node)).toBe("sensitive_user_data");
    expect(canCollectCleanupNode(node)).toBe(false);
  });

  it("trusts the backend allowlist for the current user's Darwin cache directory", () => {
    const node = cleanupNode("/private/var/folders/aa/user/C/cache.bin");
    node.deletionProtected = false;
    node.protectionReason = null;
    expect(cleanupNodeProtection(node)).toBeNull();
    expect(canCollectCleanupNode(node)).toBe(true);
  });

  it.each([
    "/tmp/core-robin-owned/cache.bin",
    "/private/var/tmp/core-robin-owned/cache.bin",
  ])("requires the backend ownership check for temporary content: %s", (path) => {
    const node = cleanupNode(path);
    expect(cleanupNodeProtection(node)).toBe("system_location");

    node.deletionProtected = false;
    node.protectionReason = null;
    expect(cleanupNodeProtection(node)).toBeNull();
    expect(canCollectCleanupNode(node)).toBe(true);
  });
});

function cleanupNode(path: string): CleanupNode {
  const parts = path.split("/");
  return {
    id: path,
    name: parts[parts.length - 1] || path,
    path,
    sizeBytes: 1,
    logicalSizeBytes: 1,
    allocatedSizeBytes: 1,
    itemCount: 1,
    safety: "review",
    kind: "file",
    hasChildren: false,
    children: [],
  };
}
