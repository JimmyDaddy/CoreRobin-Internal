/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "./i18n";
import { DailyApplications } from "./components/DailyApplications";
import { DailyHome } from "./components/DailyHome";
import { analyzeSystemHealth, type ApplicationImpact } from "./diagnosis";
import { getMockSnapshot } from "./mockData";

afterEach(() => cleanup());
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

describe("everyday component interactions", () => {
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
      />,
    );
    expect(screen.getByText("84%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /更新列表/ }));
    await waitFor(() => expect(screen.getByText("Beta")).toBeTruthy());
    expect(onRefresh).toHaveBeenCalledOnce();
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
        alertEvents={[]}
        onOpenIntent={() => undefined}
        onOpenSolve={() => undefined}
        onOpenRecords={() => undefined}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /检查一下/ }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });
});

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
