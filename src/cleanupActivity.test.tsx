/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CleanupSettlementDialog } from "./components/CleanupSettlementDialog";
import { CleanupProcessing } from "./components/CleanupProcessing";
import type { CleanupDeleteOutcome } from "./cleanupOutcome";
import i18n from "./i18n";

const gib = 1024 ** 3;
const completed: CleanupDeleteOutcome = {
  deletedCount: 3,
  deletedBytes: 10 * gib,
  selectedLogicalBytes: 12 * gib,
  selectedAllocatedBytes: 10 * gib,
  availableBytesBefore: 50 * gib,
  availableBytesAfter: 58 * gib,
  failed: [],
  cancelled: false,
  mode: "permanent",
};

beforeEach(async () => {
  document.documentElement.dataset.reduceMotion = "true";
  await i18n.changeLanguage("en");
});
afterEach(() => { cleanup(); delete document.documentElement.dataset.reduceMotion; });

describe("cleanup settlement", () => {
  it("settles on measured free-space growth instead of the selected or processed size", () => {
    render(<CleanupSettlementDialog outcome={completed} onClose={vi.fn()} />);
    expect(screen.getByText("Increase in available space")).toBeTruthy();
    expect(screen.getByLabelText("8 GB")).toBeTruthy();
    expect(screen.getByText("Processed 10 GB")).toBeTruthy();
  });

  it("labels trash movement without claiming disk space was freed", () => {
    render(<CleanupSettlementDialog outcome={{ ...completed, mode: "trash" }} onClose={vi.fn()} />);
    expect(screen.getByText("Moved to Trash")).toBeTruthy();
    expect(screen.getByLabelText("10 GB")).toBeTruthy();
    expect(screen.queryByText("Increase in available space")).toBeNull();
    expect(screen.getByText(/Items remain recoverable/)).toBeTruthy();
  });

  it("does not invent a space measurement when the backend has none", () => {
    render(<CleanupSettlementDialog outcome={{ ...completed, availableBytesBefore: null, availableBytesAfter: null }} onClose={vi.fn()} />);
    expect(screen.getByText("Space processed")).toBeTruthy();
    expect(screen.getByText(/measurements were not obtained/)).toBeTruthy();
  });

  it.each([
    ["cancelled", { ...completed, cancelled: true }],
    ["partial", { ...completed, failed: [{ path: "/busy", message: "busy" }] }],
    ["failed", { ...completed, deletedCount: 0, deletedBytes: 0, failed: [{ path: "/busy", message: "busy" }] }],
    ["empty", { ...completed, deletedCount: 0, deletedBytes: 0 }],
  ] satisfies [string, CleanupDeleteOutcome][])("does not celebrate a %s outcome as successful", (status, outcome) => {
    const { container } = render(<CleanupSettlementDialog outcome={outcome} onClose={vi.fn()} />);
    expect(container.querySelector(`.cleanup-settlement.is-${status}`)).not.toBeNull();
    expect(container.querySelector(".cleanup-activity__burst")).toBeNull();
    expect(container.querySelector(".is-celebrating")).toBeNull();
  });

  it("does not replay celebration when reopening the receipt", () => {
    const { container } = render(<CleanupSettlementDialog outcome={completed} celebrate={false} onClose={vi.fn()} />);
    expect(container.querySelector(".cleanup-activity__burst")).toBeNull();
    expect(screen.getByLabelText("8 GB").textContent).toBe("8 GB");
  });

  it("keeps keyboard focus inside the receipt and allows immediate dismissal", () => {
    const onClose = vi.fn();
    render(<CleanupSettlementDialog outcome={completed} onClose={onClose} />);
    const [first, last] = screen.getAllByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("cleanup processing feedback", () => {
  it.each(["trash", "permanent"] as const)("tosses files into a bin in %s mode and only shreds permanent deletions", (mode) => {
    const { container } = render(<CleanupProcessing progress={null} mode={mode} cancelling={false} targetCount={3} />);
    expect(container.querySelectorAll(".cleanup-activity__packet")).toHaveLength(3);
    expect(container.querySelector(".cleanup-activity__bin-lid")).not.toBeNull();
    expect(container.querySelector(".cleanup-activity__bin-body")).not.toBeNull();
    expect(container.querySelectorAll(".cleanup-activity__shred")).toHaveLength(mode === "permanent" ? 9 : 0);
  });

  it("does not show a fabricated percent while the entry total is unknown", () => {
    render(<CleanupProcessing progress={null} mode="permanent" cancelling={false} targetCount={3} />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("shows reported progress and stops the processing effect when cancelling", () => {
    const { container } = render(<CleanupProcessing
      progress={{ phase: "deleting", processedEntryCount: 25, totalEntryCount: 100, completedTargetCount: 1, totalTargetCount: 3, currentPath: "/fixture/current", deletedBytes: gib }}
      mode="permanent" cancelling targetCount={3}
    />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(container.querySelector(".cleanup-activity__packets")).toBeNull();
    expect(container.querySelector(".cleanup-activity__discard")).toBeNull();
    expect(container.querySelector(".cleanup-activity.is-cancelling")).not.toBeNull();
  });
});
