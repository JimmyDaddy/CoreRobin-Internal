/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { StrictMode } from "react";
import { CapabilityResultCard } from "./CapabilityResultCard";
import { readCapabilityResult } from "./contracts";

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
afterEach(cleanup);
const disk = () => readCapabilityResult("scan_disk_usage", JSON.stringify({
  sampledAt: 1000, scanId: "scan", sourceRevision: 3, scannedEntries: 42, unreadableEntries: 2,
  items: ["one", "two"].map((id) => ({ targetRef: `native-${id}`, name: `Folder ${id}`, allocatedBytes: 1024, logicalBytes: 1024, itemCount: 2, safety: "review" })),
}))!;
it("shows real scan entries and sends only the user's selected native reference", () => {
  const onAction = vi.fn();
  render(<StrictMode><CapabilityResultCard result={disk()} actionsEnabled busy={false} onAction={onAction} /></StrictMode>);
  expect(screen.getByText("Folder one")).toBeTruthy();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Folder two" }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("capabilities:trashSelected") }));
  expect(onAction).toHaveBeenCalledWith({ action: "trash", targetRefs: ["native-two"] });
});
it("keeps historical results readable while disabling stale writes, with refresh available", () => {
  const onAction = vi.fn();
  render(<CapabilityResultCard result={disk()} actionsEnabled stale busy={false} onAction={onAction} />);
  expect((screen.getByRole("checkbox", { name: "Folder one" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("capabilities:trashSelected") }));
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("capabilities:refresh") }));
  expect(onAction).toHaveBeenCalledWith({ action: "refresh", targetRefs: [] });
});
it("does not turn malformed device values into reassuring zero measurements", () => {
  expect(readCapabilityResult("get_device_status", '{"cpu":{},"memory":{}}')).toBeNull();
  expect(readCapabilityResult("get_process_usage", '{"processes":[{"name":"Injected","pid":12,"memoryBytes":2}]}')).toMatchObject({ items: [{ protected: true, targetRef: null }] });
});
it("reports incomplete index updates after actual cleanup without claiming a fresh scan", () => {
  const result = readCapabilityResult("request_cleanup", '{"deleted":[{"name":"A","deletedBytes":12}],"failed":[],"indexUpdated":false}')!;
  render(<CapabilityResultCard result={result} actionsEnabled={false} busy={false} />);
  expect(screen.getByText(i18n.t("capabilities:stale"))).toBeTruthy();
});
it("localizes historical facts and coverage without losing missing-record or probe semantics", () => {
  const result = readCapabilityResult("get_recorded_history", JSON.stringify({ observations: [
    { label: "Historical disk reads mean", value: 1024, unit: "bytes/second" },
    { label: "Historical TCP probe failure percentage (not packet loss)", value: 20, unit: "%" },
    { label: "Resource alert 1", value: "memory, recovered, 42 seconds ago" },
  ], coverage: ["No saved resource-alert events cover this range. The selected incident cannot be reconstructed from missing records."] }))!;
  render(<CapabilityResultCard result={result} actionsEnabled={false} busy={false} />);
  expect(screen.getByText("磁盘读取 · 平均值")).toBeTruthy();
  expect(screen.getByText("TCP 探测失败率（非丢包率）")).toBeTruthy();
  expect(screen.getByText("内存 · 已恢复 · 42 秒前")).toBeTruthy();
  expect(screen.getByText(i18n.t("capabilities:history.noAlerts"))).toBeTruthy();
  expect(screen.queryByText(/Historical/)).toBeNull();
});
