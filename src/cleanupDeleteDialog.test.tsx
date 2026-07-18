/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CleanupMapNode } from "./cleanupMap";
import { CleanupDeleteDialog } from "./components/CleanupDeleteDialog";
import i18n from "./i18n";
import type { CleanupDeleteLease } from "./types";

const item: CleanupMapNode = {
  id: "downloads/archive",
  name: "archive",
  path: "~/Downloads/archive",
  sizeBytes: 4_096,
  logicalSizeBytes: 1_000,
  allocatedSizeBytes: 4_096,
  itemCount: 1,
  safety: "review",
  kind: "folder",
  hasChildren: true,
  children: [],
};

afterEach(() => cleanup());
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

describe("cleanup deletion dialog freshness", () => {
  it("keeps acknowledgement disabled until an executable lease exists", () => {
    renderDialog(null, { preparing: true });
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /永久删除 1 项/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires another refresh when the backend reports changed paths", () => {
    const onRefresh = vi.fn();
    renderDialog(lease(false), { onRefresh });
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "再次刷新所选内容" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("requires a new acknowledgement for the executable refreshed lease", () => {
    const onConfirm = vi.fn();
    renderDialog(lease(true), { onConfirm });
    const confirm = screen.getByRole("button", { name: /永久删除 1 项/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("offers Trash and direct deletion as explicit modes", () => {
    const onModeChange = vi.fn();
    renderDialog(lease(true, "trash"), { mode: "trash", onModeChange });
    expect(screen.getByRole("radio", { name: /移到废纸篓/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /直接删除/ }));
    expect(onModeChange).toHaveBeenCalledWith("permanent");
  });
});

function lease(executable: boolean, mode: CleanupDeleteLease["mode"] = "permanent"): CleanupDeleteLease {
  return {
    id: executable ? "executable" : "refresh-only",
    mode,
    paths: [item.path!],
    changedPaths: executable ? [] : [item.path!],
    refreshedTargets: [{
      path: item.path!,
      logicalSizeBytes: item.logicalSizeBytes,
      allocatedSizeBytes: item.allocatedSizeBytes,
      itemCount: item.itemCount,
    }],
    executable,
    refreshedAtMs: 200,
    expiresAtMs: 300,
  };
}

function renderDialog(
  currentLease: CleanupDeleteLease | null,
  overrides: Partial<ComponentProps<typeof CleanupDeleteDialog>> = {},
) {
  const props: ComponentProps<typeof CleanupDeleteDialog> = {
    items: [item],
    lease: currentLease,
    preparing: false,
    submitting: false,
    cancelling: false,
    progress: null,
    error: null,
    mode: "permanent",
    deleteAcknowledged: false,
    onModeChange: () => undefined,
    onDeleteAcknowledgedChange: () => undefined,
    onCancel: () => undefined,
    onCancelExecution: () => undefined,
    onRefresh: () => undefined,
    onConfirm: () => undefined,
    ...overrides,
  };
  const view = render(<CleanupDeleteDialog {...props} />);
  if (overrides.onDeleteAcknowledgedChange) return view;
  const originalRerender = view.rerender;
  props.onDeleteAcknowledgedChange = (checked) => {
    props.deleteAcknowledged = checked;
    originalRerender(<CleanupDeleteDialog {...props} />);
  };
  originalRerender(<CleanupDeleteDialog {...props} />);
  return view;
}
