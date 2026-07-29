/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "./i18n";
import { DailyApplications } from "./components/DailyApplications";
import { DailyGuide } from "./components/DailyGuide";
import { DailyHome } from "./components/DailyHome";
import { DailySettings } from "./components/DailySettings";
import type { DailyIncident } from "./dailyIncidents";
import {
  analyzeSystemHealth,
  type ApplicationImpact,
  type DiagnosisFinding,
} from "./diagnosis";
import { getMockSnapshot } from "./mockData";
import type { AppUpdaterController } from "./hooks/useAppUpdater";
import { defaultAppSettings } from "./settings";

const updaterStub: AppUpdaterController = {
  checking: false,
  result: null,
  installableUpdate: null,
  progress: null,
  action: "idle",
  availableVersion: null,
  lastCheckedAt: null,
  lastCheckFailed: false,
  updatedFromVersion: null,
  check: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  restart: vi.fn(async () => undefined),
  skipAvailableVersion: vi.fn(),
  dismissUpdatedReceipt: vi.fn(),
};

afterEach(() => cleanup());
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

describe("everyday component interactions", () => {
  it("exposes Dock and login startup controls", () => {
    const onChange = vi.fn();
    render(
      <DailySettings
        settings={defaultAppSettings()}
        notificationStatus="disabled"
        snapshot={getMockSnapshot()}
        updater={updaterStub}
        onChange={onChange}
        onOpenOnboarding={() => undefined}
        onClearAllData={async () => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "在 Dock 中显示应用" }));
    fireEvent.click(screen.getByRole("switch", { name: "登录时启动" }));

    expect(onChange).toHaveBeenNthCalledWith(1, { showDockIcon: false });
    expect(onChange).toHaveBeenNthCalledWith(2, { launchAtLogin: true });
  });

  it("keeps a full application snapshot stable until the user refreshes it", async () => {
    const initial = application("Alpha", 84);
    const updated = application("Beta", 48);
    const onRefresh = vi.fn(async () => ({
      applications: [updated],
      totalMemoryBytes: 8 * 1_024 ** 3,
      sampledAtMs: 2_000,
    }));
    const view = render(
      <DailyApplications
        applications={[initial]}
        totalMemoryBytes={8 * 1_024 ** 3}
        sampledAtMs={1_000}
        preparingAction={false}
        recheck={null}
        onRefresh={onRefresh}
        onRequestClose={() => undefined}
        onRequestRestart={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(screen.getByText("84%")).toBeTruthy();

    view.rerender(
      <DailyApplications
        applications={[{ ...initial, cpuPercent: 1 }]}
        totalMemoryBytes={8 * 1_024 ** 3}
        sampledAtMs={1_500}
        preparingAction={false}
        recheck={null}
        onRefresh={onRefresh}
        onRequestClose={() => undefined}
        onRequestRestart={() => undefined}
      />,
    );
    expect(screen.getByText("84%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /更新列表/ }));
    await waitFor(() => expect(screen.getByText("Beta")).toBeTruthy());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("offers a safe restart action for a user application", () => {
    const onRequestRestart = vi.fn();
    render(
      <DailyApplications
        applications={[application("Alpha", 84)]}
        totalMemoryBytes={8 * 1_024 ** 3}
        sampledAtMs={1_000}
        preparingAction={false}
        recheck={null}
        onRefresh={async () => ({ applications: [], totalMemoryBytes: 0, sampledAtMs: 2_000 })}
        onRequestClose={() => undefined}
        onRequestRestart={onRequestRestart}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "重新启动 Alpha" }));

    expect(onRequestRestart).toHaveBeenCalledWith("Alpha:1", "Alpha");
  });

  it("runs the real home check callback instead of only changing decoration", async () => {
    const snapshot = getMockSnapshot();
    snapshot.processes = snapshot.processes.map((process) => ({
      ...process,
      cpuPercent: 0,
      memoryBytes: 1_024 ** 2,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
    }));
    snapshot.sensors.sleep.blockers = [];
    snapshot.sensors.temperature.celsius = 55;
    snapshot.sensors.battery = {
      ...snapshot.sensors.battery,
      present: true,
      chargePercent: 80,
      state: "discharging",
    };
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    const onRefresh = vi.fn(async () => undefined);
    render(
      <DailyHome
        diagnosis={diagnosis}
        snapshot={snapshot}
        incidents={[]}
        alertEvents={[]}
        onOpenIncident={() => undefined}
        onOpenCheck={() => undefined}
        onOpenSolve={() => undefined}
        onOpenRecords={() => undefined}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /检查一下/ }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });

  it("lets Robin react to the status item being observed", () => {
    const snapshot = calmSnapshot();
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    render(
      <DailyHome
        diagnosis={diagnosis}
        snapshot={snapshot}
        incidents={[]}
        alertEvents={[]}
        onOpenIncident={() => undefined}
        onOpenCheck={() => undefined}
        onOpenSolve={() => undefined}
        onOpenRecords={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    const speedCheck = screen.getByLabelText(/^速度:/);
    const rig = speedCheck.closest(".daily-companion__rig");
    const callout = rig?.querySelector(".daily-companion__callout");

    fireEvent.pointerEnter(speedCheck);
    expect(rig?.getAttribute("data-focus")).toBe("speed");
    expect(speedCheck.getAttribute("data-active")).toBe("true");
    expect(callout?.textContent).toBe("速度");

    fireEvent.pointerLeave(speedCheck);
    expect(rig?.hasAttribute("data-focus")).toBe(false);
  });

  it("opens the matching destination from every companion status button", () => {
    const snapshot = calmSnapshot();
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    const onOpenCheck = vi.fn();
    render(
      <DailyHome
        diagnosis={diagnosis}
        snapshot={snapshot}
        incidents={[]}
        alertEvents={[]}
        onOpenIncident={() => undefined}
        onOpenCheck={onOpenCheck}
        onOpenSolve={() => undefined}
        onOpenRecords={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    for (const label of ["速度", "空间", "温度", "电池"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}:`) }));
    }

    expect(onOpenCheck.mock.calls.map(([kind]) => kind)).toEqual([
      "speed",
      "space",
      "temperature",
      "battery",
    ]);
  });

  it("shows battery health and cycle count in the heat evidence", () => {
    const snapshot = calmSnapshot();
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    render(
      <DailyGuide
        intent="heat"
        incident={null}
        incidents={[]}
        pendingIncidentCount={0}
        diagnosis={diagnosis}
        snapshot={snapshot}
        cleanupSnapshot={null}
        cleanupLoading={false}
        startupSnapshot={null}
        startupError={null}
        startupLoading={false}
        connectionsSnapshot={null}
        connectionsError={null}
        connectionsLoading={false}
        preparingAction={false}
        recheck={null}
        onBack={() => undefined}
        onRefresh={() => undefined}
        onOpenCleanup={() => undefined}
        onOpenSpace={() => undefined}
        onOpenApplications={() => undefined}
        onOpenNetworkDetails={() => undefined}
        onOpenIntent={() => undefined}
        onOpenIncident={() => undefined}
        onRefreshStartup={() => undefined}
        onRequestClose={() => undefined}
        onOpenSystemSettings={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("为什么这样判断"));
    expect(screen.getByText("健康度")).toBeTruthy();
    expect(screen.getByText("94%")).toBeTruthy();
    expect(screen.getByText("循环次数")).toBeTruthy();
    expect(screen.getByText("173")).toBeTruthy();
  });

  it("opens the exact stable incident represented by the home count", () => {
    const snapshot = calmSnapshot();
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    const incident = cpuIncident("active");
    const onOpenIncident = vi.fn();
    render(
      <DailyHome
        diagnosis={diagnosis}
        snapshot={snapshot}
        incidents={[incident]}
        alertEvents={[]}
        onOpenIncident={onOpenIncident}
        onOpenCheck={() => undefined}
        onOpenSolve={() => undefined}
        onOpenRecords={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "有 1 项情况值得留意" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /看看原因/ }));
    expect(onOpenIncident).toHaveBeenCalledWith(incident);
  });

  it("keeps resolved incident evidence visible without stale close actions", () => {
    const snapshot = calmSnapshot();
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    const incident = cpuIncident("resolved");
    render(
      <DailyGuide
        intent="slow"
        incident={incident}
        incidents={[]}
        pendingIncidentCount={0}
        diagnosis={diagnosis}
        snapshot={snapshot}
        cleanupSnapshot={null}
        cleanupLoading={false}
        startupSnapshot={null}
        startupError={null}
        startupLoading={false}
        connectionsSnapshot={null}
        connectionsError={null}
        connectionsLoading={false}
        preparingAction={false}
        recheck={null}
        onBack={() => undefined}
        onRefresh={() => undefined}
        onOpenCleanup={() => undefined}
        onOpenSpace={() => undefined}
        onOpenApplications={() => undefined}
        onOpenNetworkDetails={() => undefined}
        onOpenIntent={() => undefined}
        onOpenIncident={() => undefined}
        onRefreshStartup={() => undefined}
        onRequestClose={() => undefined}
        onOpenSystemSettings={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "处理器持续繁忙" })).toBeTruthy();
    expect(screen.getByText(/这项情况已经稳定恢复/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /退出/ })).toBeNull();
  });
});

function calmSnapshot() {
  const snapshot = structuredClone(getMockSnapshot());
  snapshot.processes = snapshot.processes.map((process) => ({
    ...process,
    cpuPercent: 0,
    memoryBytes: 1_024 ** 2,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
  }));
  snapshot.sensors.sleep.blockers = [];
  snapshot.sensors.temperature.celsius = 55;
  snapshot.sensors.battery = {
    ...snapshot.sensors.battery,
    present: true,
    chargePercent: 80,
    state: "discharging",
  };
  return snapshot;
}

function cpuIncident(phase: DailyIncident["phase"]): DailyIncident {
  const finding = cpuFinding();
  return {
    id: "diagnosis:sustained_cpu",
    occurrenceId: "diagnosis:sustained_cpu:1000",
    phase,
    item: {
      id: "diagnosis:sustained_cpu",
      kind: "diagnosis",
      level: "attention",
      intent: "slow",
      finding,
    },
    peakItem: {
      id: "diagnosis:sustained_cpu",
      kind: "diagnosis",
      level: "attention",
      intent: "slow",
      finding,
    },
    firstObservedAtMs: 1_000,
    activatedAtMs: 2_000,
    lastObservedAtMs: 3_000,
    recoveryStartedAtMs: phase === "active" ? null : 4_000,
    resolvedAtMs: phase === "resolved" ? 5_000 : null,
  };
}

function cpuFinding(): DiagnosisFinding {
  return {
    id: "sustained_cpu",
    code: "sustained_cpu",
    category: "cpu",
    severity: "attention",
    actionTarget: "processes",
    value: 82,
    threshold: 75,
    durationMs: 20_000,
    secondaryValue: null,
    resourceLabel: null,
    culprit: null,
    recommendation: {
      kind: "inspect_process",
      safety: "safe",
      target: "processes",
      processIdentity: null,
      applicationName: null,
    },
  };
}

function application(name: string, cpuPercent: number): ApplicationImpact {
  return {
    id: name.toLocaleLowerCase(),
    name,
    processCount: 1,
    cpuPercent,
    memoryBytes: 512 * 1_024 ** 2,
    diskBytesPerSecond: 0,
    systemComponent: false,
    representativeIdentity: `${name}:1`,
    actionIdentity: `${name}:1`,
    memberIdentities: [`${name}:1`],
    iconProcess: { pid: 1, snapshotBirthToken: "1", snapshotStartTime: 1 },
  };
}
