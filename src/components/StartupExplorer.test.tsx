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
  openSystemSettings: vi.fn(),
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
  it("shows a localized recovery message instead of a raw backend failure", () => {
    render(
      <StartupExplorer
        snapshot={null}
        error={{ code: "command_failed", message: "launchctl returned exit code 78" }}
        loading={false}
        applications={[]}
        totalMemoryBytes={16_000_000_000}
        onRefresh={() => undefined}
      />,
    );

    expect(screen.getByText("暂时无法读取启动项。没有修改任何内容，请重试。")).toBeTruthy();
    expect(screen.queryByText("launchctl returned exit code 78")).toBeNull();
  });

  it("keeps a System Settings failure visible on the page", async () => {
    apiMocks.openSystemSettings.mockRejectedValueOnce(new Error("bridge unavailable"));
    render(
      <StartupExplorer
        snapshot={{
          ...snapshot,
          items: [{
            ...snapshot.items[0]!,
            managementStatus: "unsupported",
          }],
        }}
        error={null}
        loading={false}
        applications={[]}
        totalMemoryBytes={16_000_000_000}
        onRefresh={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "登录时打开" }));
    fireEvent.click(screen.getByRole("button", { name: "前往系统设置管理" }));
    expect(await screen.findByText("未能打开系统设置，请重试，或在系统设置中手动打开“登录项”。")).toBeTruthy();
  });

  it("creates one fresh targeted safety lease only when the user confirms", async () => {
    const executionLease = lease("execution");
    apiMocks.createStartupManagementLease.mockResolvedValueOnce(executionLease);
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
    expect(apiMocks.createStartupManagementLease).not.toHaveBeenCalled();
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(apiMocks.createStartupManagementLease).toHaveBeenCalledTimes(1);
      expect(apiMocks.executeStartupManagement).toHaveBeenCalledWith({
        leaseId: executionLease.id,
      });
      expect(onRefresh).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole("button", { name: "撤销" })).toBeTruthy();
  });

  it("does not present unsupported modern background items as guided actions", () => {
    render(
      <StartupExplorer
        variant="guided"
        snapshot={{
          ...snapshot,
          items: [{
            ...snapshot.items[0]!,
            id: "modern-item",
            modernBackgroundItem: true,
            managementStatus: "unsupported",
          }],
        }}
        error={null}
        loading={false}
        applications={[]}
        totalMemoryBytes={16_000_000_000}
        onRefresh={() => undefined}
      />,
    );

    expect(screen.getByText("没有需要处理的第三方登录项")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停用开机启动" })).toBeNull();
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
