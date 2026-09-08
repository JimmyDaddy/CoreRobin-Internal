import { afterEach, expect, it, vi } from "vitest";
import type { FileInsightsScan } from "./types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { clearPersistedFileInsightsScan, loadPersistedFileInsightsScan, savePersistedFileInsightsScan } from "./fileInsightsPersistence";
afterEach(() => vi.unstubAllGlobals());
it("waits for an issued native save before clearing and reading, so old writes cannot restore deleted data", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  let saved!: () => void;
  invoke.mockImplementation((command) => command === "save_persisted_file_insights_scan"
    ? new Promise<void>((resolve) => { saved = resolve; }) : Promise.resolve(null));
  const save = savePersistedFileInsightsScan({ sampledAtMs: 10 } as FileInsightsScan);
  await Promise.resolve();
  const clear = clearPersistedFileInsightsScan();
  const read = loadPersistedFileInsightsScan();
  await Promise.resolve();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["save_persisted_file_insights_scan"]);
  saved();
  await Promise.all([save, clear, read]);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["save_persisted_file_insights_scan", "clear_persisted_file_insights_scan", "load_persisted_file_insights_scan"]);
});
