/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { AiToolStep } from "../../ai/types";
const resolveToolConfirmation = vi.hoisted(() => vi.fn());
vi.mock("../../ai/api", () => ({ aiApi: { resolveToolConfirmation } }));
import { AiToolSteps } from "./AiToolSteps";

const step = (overrides: Partial<AiToolStep> = {}): AiToolStep => ({
  id: "step-1", name: "request_process_action", state: "awaiting_confirmation",
  startedAt: Date.now(), finishedAt: null, result: null, error: null,
  confirmation: { action: "request_close", targets: ["Synthetic editor · PID 123"], detail: "Unsaved work risk", expiresAt: Date.now() + 60_000 },
  ...overrides,
});
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("zh-CN"); resolveToolConfirmation.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("native task confirmations", () => {
  it("shows the native target and waits for an explicit, single-use decision", async () => {
    let finish: () => void = () => {};
    resolveToolConfirmation.mockImplementation(() => new Promise<void>((done) => { finish = done; }));
    const onResolved = vi.fn().mockResolvedValue(undefined);
    render(<AiToolSteps steps={[step()]} requestId="run-1" active onResolved={onResolved} />);
    expect(screen.getByText("Synthetic editor · PID 123")).toBeTruthy();
    expect(resolveToolConfirmation).not.toHaveBeenCalled();
    const approve = screen.getByRole("button", { name: i18n.t("ai:toolApprove") });
    fireEvent.click(approve); fireEvent.click(approve);
    expect(resolveToolConfirmation).toHaveBeenCalledTimes(1);
    expect(resolveToolConfirmation).toHaveBeenCalledWith("run-1", "step-1", true);
    await act(async () => finish());
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect((approve as HTMLButtonElement).disabled).toBe(true);
  });
  it("declines without approving and refreshes the native task", async () => {
    const onResolved = vi.fn().mockResolvedValue(undefined);
    render(<AiToolSteps steps={[step()]} requestId="run-1" active onResolved={onResolved} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:toolDecline") }));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(resolveToolConfirmation).toHaveBeenCalledWith("run-1", "step-1", false);
  });
  it("cannot execute a historical or expired confirmation", () => {
    const onResolved = vi.fn();
    const { rerender } = render(<AiToolSteps steps={[step()]} requestId="run-old" active={false} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:toolApprove") }));
    rerender(<AiToolSteps steps={[step({ confirmation: { action: "trash", targets: ["/synthetic/item"], detail: "Trash only", expiresAt: Date.now() - 10 } })]} requestId="run-1" active onResolved={onResolved} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:toolApprove") }));
    expect(screen.getByText(i18n.t("ai:toolConfirmationExpired"))).toBeTruthy();
    expect(resolveToolConfirmation).not.toHaveBeenCalled();
  });
  it("expires a displayed confirmation while waiting", async () => {
    vi.useFakeTimers();
    render(<AiToolSteps steps={[step({ confirmation: { action: "trash", targets: ["/synthetic/item"], detail: "Trash only", expiresAt: Date.now() + 500 } })]} requestId="run-1" active onResolved={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect((screen.getByRole("button", { name: i18n.t("ai:toolApprove") }) as HTMLButtonElement).disabled).toBe(true);
    expect(resolveToolConfirmation).not.toHaveBeenCalled();
  });
  it("refreshes after an uncertain IPC error without permitting a blind duplicate", async () => {
    resolveToolConfirmation.mockRejectedValue({ code: "stale_state", message: "Native decision already changed" });
    const onResolved = vi.fn().mockResolvedValue(undefined);
    render(<AiToolSteps steps={[step()]} requestId="run-1" active onResolved={onResolved} />);
    const approve = screen.getByRole("button", { name: i18n.t("ai:toolApprove") });
    fireEvent.click(approve);
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    fireEvent.click(approve);
    expect(resolveToolConfirmation).toHaveBeenCalledTimes(1);
  });
  it("renders tool evidence as inert text and preserves cancelled progress", () => {
    render(<AiToolSteps steps={[step({ name: "get_device_status", state: "cancelled", confirmation: null, result: '{"name":"<script>danger()</script>"}' })]} requestId={null} active={false} onResolved={vi.fn()} />);
    expect(screen.getByText(i18n.t("ai:statusCancelled"))).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain("<script>danger()</script>");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
