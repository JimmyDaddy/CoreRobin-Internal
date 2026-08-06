/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrphanProcessCard } from "./components/OrphanProcessCard";
import i18n from "./i18n";
import type { OrphanProcess } from "./types";

const orphanApi = vi.hoisted(() => ({
  scanOrphanProcesses: vi.fn(),
  killOrphanProcesses: vi.fn(),
}));

vi.mock("./api", () => orphanApi);

const ORPHANS: OrphanProcess[] = [
  {
    pid: 421,
    startTime: 1_750_000_000,
    name: "leftover-agent",
    commandLine: "/usr/local/bin/leftover-agent --daemon",
    parentPid: 1,
    parentName: "launchd",
    user: "501",
    cpuPercent: 0.4,
    memoryBytes: 96_000_000,
    status: "Running",
    orphanReason: "parent_exited",
  },
  {
    pid: 422,
    startTime: 1_750_000_100,
    name: "orphan-helper",
    commandLine: "/tmp/orphan-helper",
    parentPid: 9999,
    parentName: null,
    user: "501",
    cpuPercent: 0.1,
    memoryBytes: 12_000_000,
    status: "Running",
    orphanReason: "parent_missing",
  },
];

afterEach(() => cleanup());
beforeEach(async () => {
  window.localStorage.clear();
  orphanApi.scanOrphanProcesses.mockReset();
  orphanApi.killOrphanProcesses.mockReset();
  await i18n.changeLanguage("zh-CN");
});

describe("OrphanProcessCard", () => {
  it("hides when there are no orphans", async () => {
    orphanApi.scanOrphanProcesses.mockResolvedValue([]);
    const { container } = render(<OrphanProcessCard />);
    await waitFor(() => expect(orphanApi.scanOrphanProcesses).toHaveBeenCalled());
    expect(container.querySelector(".orphan-card")).toBeNull();
  });

  it("lists orphans with memory usage and supports batch kill with confirmation", async () => {
    orphanApi.scanOrphanProcesses.mockResolvedValue(ORPHANS);
    orphanApi.killOrphanProcesses.mockResolvedValue({
      outcomes: [
        { pid: 421, name: "leftover-agent", status: "killed", message: null },
        { pid: 422, name: "orphan-helper", status: "killed", message: null },
      ],
    });
    render(<OrphanProcessCard />);

    await waitFor(() => expect(screen.getByText(/2 个无主进程/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "查看并清理" }));
    expect(screen.getByText("leftover-agent")).toBeTruthy();
    expect(screen.getByText("orphan-helper")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "一键清理全部" }));
    expect(screen.getByText(/确认结束全部 2 个无主进程/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认清理" }));

    await waitFor(() => expect(orphanApi.killOrphanProcesses).toHaveBeenCalled());
    expect(orphanApi.killOrphanProcesses).toHaveBeenCalledWith({
      targets: [
        { pid: 421, expectedStartTime: 1_750_000_000 },
        { pid: 422, expectedStartTime: 1_750_000_100 },
      ],
      force: true,
    });
    await waitFor(() => expect(screen.getByText("清理结果")).toBeTruthy());
  });

  it("inspects a single orphan and offers force end after a survived term", async () => {
    orphanApi.scanOrphanProcesses.mockResolvedValue(ORPHANS);
    orphanApi.killOrphanProcesses.mockResolvedValue({
      outcomes: [
        { pid: 421, name: "leftover-agent", status: "survived", message: "still running" },
      ],
    });
    render(<OrphanProcessCard />);
    await waitFor(() => expect(screen.getByText(/2 个无主进程/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "查看并清理" }));

    const inspectButtons = screen.getAllByRole("button", { name: "检查" });
    fireEvent.click(inspectButtons[0]);
    expect(screen.getByText(/leftover-agent --daemon/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "结束" })[0]);
    await waitFor(() =>
      expect(orphanApi.killOrphanProcesses).toHaveBeenCalledWith({
        targets: [{ pid: 421, expectedStartTime: 1_750_000_000 }],
        force: false,
      }),
    );
    await waitFor(() => expect(screen.getByText("强制结束")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "强制结束" }));
    await waitFor(() =>
      expect(orphanApi.killOrphanProcesses).toHaveBeenLastCalledWith(
        expect.objectContaining({ force: true }),
      ),
    );
  });
});
