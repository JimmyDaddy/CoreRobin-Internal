/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import type {
  StartupItemsSnapshot,
  StartupManagementLease,
} from "../types";
import { StartupExplorer } from "./StartupExplorer";

const apiMocks = vi.hoisted(() => ({
  createStartupManagementLease: vi.fn(),
  executeStartupManagement: vi.fn(),
  releaseStartupManagementLease: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

afterEach(cleanup);

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh-CN");
  apiMocks.releaseStartupManagementLease.mockResolvedValue(undefined);
});

describe("startup management confirmation", () => {
  it("renews the safety lease when the user confirms the action", async () => {
    const previewLease = lease("preview");
    const executionLease = lease("execution");
    apiMocks.createStartupManagementLease
      .mockResolvedValueOnce(previewLease)
      .mockResolvedValueOnce(executionLease);
    apiMocks.executeStartupManagement.mockResolvedValue({
      itemId: "login-item",
      enabled: false,
    });
    const onRefresh = vi.fn(async () => undefined);

    render(
      <StartupExplorer
        variant="guided"
        snapshot={snapshot}
        error={null}
        loading={false}
        applications={[]}
        totalMemoryBytes={16_000_000_000}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "停用开机启动" }));
    const confirm = await screen.findByRole("button", {
      name: "确认停用自动启动",
    });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(apiMocks.createStartupManagementLease).toHaveBeenCalledTimes(2);
      expect(apiMocks.releaseStartupManagementLease).toHaveBeenCalledWith({
        leaseId: previewLease.id,
      });
      expect(apiMocks.executeStartupManagement).toHaveBeenCalledWith({
        leaseId: executionLease.id,
      });
      expect(onRefresh).toHaveBeenCalledOnce();
    });
  });
});

const snapshot: StartupItemsSnapshot = {
  sampledAtMs: Date.now(),
  unreadableLocationCount: 0,
  managementAvailable: true,
  items: [{
    id: "login-item",
    name: "Sample Helper",
    publisher: "Sample",
    command: "/Applications/Sample.app/Contents/MacOS/Sample",
    path: "/Users/demo/Library/LaunchAgents/com.example.sample.plist",
    source: "launch_agent",
    scope: "user",
    enabled: true,
    system: false,
    launchKind: "login",
    managementStatus: "available",
  }],
};

function lease(id: string): StartupManagementLease {
  return {
    id,
    itemId: "login-item",
    itemName: "Sample Helper",
    action: "disable",
    expiresAtMs: Date.now() + 60_000,
  };
}
