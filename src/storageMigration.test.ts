import { describe, expect, it } from "vitest";

import {
  readMigratedStorageItem,
  removeStorageItems,
} from "./storageMigration";

describe("brand storage migration", () => {
  it("moves a legacy value to the current key", () => {
    const values = new Map<string, string>([["legacy.key", "saved-value"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    expect(readMigratedStorageItem(storage, "current.key", ["legacy.key"]))
      .toBe("saved-value");
    expect(values.get("current.key")).toBe("saved-value");
    expect(values.has("legacy.key")).toBe(false);
  });

  it("prefers current data and clears both current and legacy keys", () => {
    const values = new Map<string, string>([
      ["current.key", "current"],
      ["legacy.key", "legacy"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    expect(readMigratedStorageItem(storage, "current.key", ["legacy.key"]))
      .toBe("current");
    removeStorageItems(storage, "current.key", ["legacy.key"]);
    expect(values.size).toBe(0);
  });
});
