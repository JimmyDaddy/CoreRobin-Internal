import { describe, expect, it, vi } from "vitest";

import { buildProcessHistoryLineSegments } from "./components/ProcessHistory";
import {
  MAX_PROCESS_HISTORY_POINTS,
  PROCESS_HISTORY_WINDOW_MS,
  buildProcessTreeProjection,
  computeVirtualRange,
  defaultProcessExplorerPreferences,
  expandableProcessTreeRootIdentities,
  loadProcessExplorerPreferences,
  parseProcessExplorerPreferences,
  pruneExpandedIdentities,
  saveProcessExplorerPreferences,
  updateSelectedProcessHistory,
} from "./processExplorer";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ProcessRow,
  type ProcessHistoryPoint,
  type ProcessSortKey,
  type SortDirection,
  type SystemSnapshot,
} from "./types";
import { processIdentity } from "./utils";

function processFixture(
  pid: number,
  overrides: Partial<ProcessRow> = {},
): ProcessRow {
  return {
    pid,
    birthToken: `test:${pid}:100`,
    parentPid: null,
    startTime: 100,
    runTimeSeconds: 10,
    name: `process-${pid}`,
    user: "tester",
    status: "Run",
    cpuPercent: 0,
    memoryBytes: pid * 1_024,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    protected: false,
    ...overrides,
  };
}

function snapshotFixture(
  sequence: number,
  sampledAtMs: number,
  processes: ProcessRow[],
): SystemSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sequence,
    sampledAtMs,
    sampleIntervalMs: 1_000,
    warmingUp: false,
    host: {
      hostname: "test-host",
      osName: "Test OS",
      osVersion: "1",
      kernelVersion: "1",
      architecture: "test",
      cpuName: "test-cpu",
    },
    cpu: {
      usagePercent: 10,
      perCorePercent: [10],
      logicalCoreCount: 1,
    },
    memory: {
      totalBytes: 1_000,
      usedBytes: 500,
      availableBytes: 500,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
    disk: {
      readBytesPerSecond: 0,
      writeBytesPerSecond: 0,
      volumes: [],
    },
    network: {
      receivedBytesPerSecond: 0,
      transmittedBytesPerSecond: 0,
      receivedBytesSinceLaunch: 0,
      transmittedBytesSinceLaunch: 0,
      interfaceCount: 0,
      interfaces: [],
    },
    sensors: {
      sampledAtMs,
      temperature: { celsius: null, componentLabel: null, criticalCelsius: null },
      battery: {
        present: false,
        chargePercent: null,
        state: "unknown",
        timeRemainingMinutes: null,
        powerSource: "unknown",
      },
      sleep: {
        sampledAtMs,
        available: false,
        blockers: [],
      },
    },
    processes,
    capabilities: {
      platform: "test",
      processControl: {
        targeting: "unavailable",
        requestClose: {
          enabled: false,
          semantic: null,
          disabledReason: "test",
        },
        forceKill: {
          enabled: false,
          semantic: null,
          disabledReason: "test",
        },
        leaseTtlMs: 0,
      },
      requiresConfirmation: true,
    },
  };
}

interface ProjectionOptions {
  query?: string;
  sortKey?: ProcessSortKey;
  direction?: SortDirection;
  expanded?: ReadonlySet<string>;
  selectedIdentity?: string | null;
  followSelection?: boolean;
}

function project(
  processes: ProcessRow[],
  options: ProjectionOptions = {},
) {
  return buildProcessTreeProjection(
    processes,
    options.query ?? "",
    options.sortKey ?? "name",
    options.direction ?? "ascending",
    options.expanded ?? new Set<string>(),
    options.selectedIdentity ?? null,
    options.followSelection ?? false,
  );
}

function expandAll(processes: ProcessRow[]): ReadonlySet<string> {
  return new Set(processes.map(processIdentity));
}

describe("process explorer preferences", () => {
  it("uses defaults for missing, malformed, or unsupported preferences", () => {
    const defaults = defaultProcessExplorerPreferences();

    expect(parseProcessExplorerPreferences(null)).toEqual(defaults);
    expect(parseProcessExplorerPreferences("{")).toEqual(defaults);
    expect(
      parseProcessExplorerPreferences(JSON.stringify({ version: 2 })),
    ).toEqual(defaults);
  });

  it("validates fields, truncates the query, and removes invalid expansions", () => {
    const query = "x".repeat(300);
    const parsed = parseProcessExplorerPreferences(
      JSON.stringify({
        version: 1,
        viewMode: "invalid",
        query,
        sortKey: "invalid",
        sortDirection: "sideways",
        expandedIdentities: ["live", "live", "", "x".repeat(513), 42],
        followSelection: "yes",
      }),
    );

    expect(parsed).toEqual({
      ...defaultProcessExplorerPreferences(),
      query: "x".repeat(256),
      expandedIdentities: ["live"],
    });
  });

  it("keeps only the latest 512 unique expansion identities", () => {
    const identities = Array.from({ length: 520 }, (_, index) => `id-${index}`);
    const parsed = parseProcessExplorerPreferences(
      JSON.stringify({
        version: 1,
        viewMode: "tree",
        query: "node",
        sortKey: "memory",
        sortDirection: "ascending",
        expandedIdentities: [...identities, "id-519"],
        followSelection: false,
      }),
    );

    expect(parsed.viewMode).toBe("tree");
    expect(parsed.sortKey).toBe("memory");
    expect(parsed.sortDirection).toBe("ascending");
    expect(parsed.followSelection).toBe(false);
    expect(parsed.expandedIdentities).toHaveLength(512);
    expect(parsed.expandedIdentities[0]).toBe("id-8");
    expect(
      parsed.expandedIdentities[parsed.expandedIdentities.length - 1],
    ).toBe("id-519");
  });

  it("prunes stale expansion identities without matching a reused PID", () => {
    const live = processFixture(7, { birthToken: "live-token" });
    const liveIdentity = processIdentity(live);

    expect(
      pruneExpandedIdentities(
        [liveIdentity, "7:old-token", "999:missing"],
        [live],
      ),
    ).toEqual([liveIdentity]);
  });

  it("bounds and deduplicates live expansion identities", () => {
    const processes = Array.from({ length: 520 }, (_, index) =>
      processFixture(index + 1),
    );
    const identities = processes.map(processIdentity);

    const pruned = pruneExpandedIdentities(
      [...identities, identities[identities.length - 1] ?? ""],
      processes,
    );

    expect(pruned).toHaveLength(512);
    expect(pruned[0]).toBe(identities[8]);
  });

  it("sanitizes stored data and survives unavailable local storage", () => {
    let stored: string | null = null;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });
    try {
      const unsafe = {
        ...defaultProcessExplorerPreferences(),
        query: "x".repeat(300),
        expandedIdentities: Array.from(
          { length: 520 },
          (_, index) => `identity-${index}`,
        ),
        selectedIdentity: "must-not-persist",
        controlLease: "must-not-persist",
      };
      saveProcessExplorerPreferences(unsafe);
      const loaded = loadProcessExplorerPreferences();
      const raw = JSON.parse(stored ?? "{}") as Record<string, unknown>;

      expect(loaded.query).toHaveLength(256);
      expect(loaded.expandedIdentities).toHaveLength(512);
      expect(raw.selectedIdentity).toBeUndefined();
      expect(raw.controlLease).toBeUndefined();

      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => {
            throw new Error("storage blocked");
          },
          setItem: () => {
            throw new Error("storage blocked");
          },
        },
      });
      expect(loadProcessExplorerPreferences()).toEqual(
        defaultProcessExplorerPreferences(),
      );
      expect(() =>
        saveProcessExplorerPreferences(defaultProcessExplorerPreferences()),
      ).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("process tree projection", () => {
  it("identifies expandable roots so tree sorting can reveal sibling order", () => {
    const root = processFixture(1, { name: "root" });
    const child = processFixture(2, { name: "child", parentPid: 1 });
    const leafRoot = processFixture(3, { name: "leaf-root" });

    expect(
      expandableProcessTreeRootIdentities([child, leafRoot, root]),
    ).toEqual([processIdentity(root)]);
  });

  it("honors expansion and assigns stable parent identities and depths", () => {
    const root = processFixture(1, { name: "root" });
    const child = processFixture(2, { name: "child", parentPid: 1 });
    const leaf = processFixture(3, { name: "leaf", parentPid: 2 });
    const sibling = processFixture(4, { name: "sibling", parentPid: 1 });
    const processes = [leaf, sibling, child, root];

    expect(project(processes).rows.map((row) => row.process.name)).toEqual([
      "root",
    ]);

    const rootExpanded = project(processes, {
      expanded: new Set([processIdentity(root)]),
    });
    expect(rootExpanded.rows.map((row) => [row.process.name, row.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["sibling", 1],
    ]);
    expect(rootExpanded.rows[1]?.parentIdentity).toBe(processIdentity(root));
    expect(rootExpanded.rows[1]?.hasChildren).toBe(true);
    expect(rootExpanded.rows[1]?.expanded).toBe(false);

    const fullyExpanded = project(processes, { expanded: expandAll(processes) });
    expect(fullyExpanded.rows.map((row) => [row.process.name, row.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["leaf", 2],
      ["sibling", 1],
    ]);
  });

  it("promotes missing-parent and impossible newer-parent children to roots", () => {
    const newerParent = processFixture(10, { name: "new-parent", startTime: 200 });
    const staleChild = processFixture(11, {
      name: "stale-child",
      parentPid: 10,
      startTime: 100,
    });
    const orphan = processFixture(12, {
      name: "orphan",
      parentPid: 999,
    });
    const projection = project([staleChild, orphan, newerParent], {
      expanded: expandAll([staleChild, orphan, newerParent]),
    });

    expect(projection.rows).toHaveLength(3);
    for (const row of projection.rows) {
      expect(row.parentIdentity).toBeNull();
      expect(row.depth).toBe(0);
    }
  });

  it("does not attach a child to an ambiguous duplicate PID", () => {
    const firstParent = processFixture(20, {
      birthToken: "parent-a",
      name: "parent-a",
    });
    const secondParent = processFixture(20, {
      birthToken: "parent-b",
      name: "parent-b",
    });
    const child = processFixture(21, { name: "child", parentPid: 20 });
    const processes = [firstParent, secondParent, child];
    const projection = project(processes, { expanded: expandAll(processes) });
    const childRow = projection.rows.find((row) => row.identity === processIdentity(child));

    expect(projection.rows).toHaveLength(3);
    expect(childRow?.parentIdentity).toBeNull();
    expect(childRow?.depth).toBe(0);
  });

  it("treats a self-parent as a root", () => {
    const selfParent = processFixture(30, { parentPid: 30 });
    const [row] = project([selfParent], {
      expanded: new Set([processIdentity(selfParent)]),
    }).rows;

    expect(row?.parentIdentity).toBeNull();
    expect(row?.depth).toBe(0);
  });

  it.each([
    [
      "two-node",
      [
        processFixture(40, { name: "a", parentPid: 41 }),
        processFixture(41, { name: "b", parentPid: 40 }),
      ],
    ],
    [
      "three-node",
      [
        processFixture(50, { name: "a", parentPid: 51 }),
        processFixture(51, { name: "b", parentPid: 52 }),
        processFixture(52, { name: "c", parentPid: 50 }),
      ],
    ],
  ])("breaks a %s parent cycle and emits every process once", (_label, processes) => {
    const projection = project(processes, { expanded: expandAll(processes) });
    const identities = projection.rows.map((row) => row.identity);

    expect(identities).toHaveLength(processes.length);
    expect(new Set(identities).size).toBe(processes.length);
    expect(projection.rows.filter((row) => row.parentIdentity === null)).toHaveLength(1);
    expect(projection.rows.map((row) => row.depth).sort()).toEqual(
      Array.from({ length: processes.length }, (_, index) => index),
    );
  });

  it("breaks cycles deterministically regardless of input order", () => {
    const a = processFixture(60, { name: "a", parentPid: 61 });
    const b = processFixture(61, { name: "b", parentPid: 62 });
    const c = processFixture(62, { name: "c", parentPid: 60 });
    const forward = [a, b, c];
    const reverse = [...forward].reverse();
    const signature = (processes: ProcessRow[]) =>
      project(processes, { expanded: expandAll(processes) }).rows.map((row) => ({
        identity: row.identity,
        parentIdentity: row.parentIdentity,
        depth: row.depth,
      }));

    expect(signature(reverse)).toEqual(signature(forward));
  });

  it("sorts siblings by the active metric without flattening the tree", () => {
    const root = processFixture(70, { name: "root", cpuPercent: 1 });
    const low = processFixture(71, {
      name: "low",
      parentPid: 70,
      cpuPercent: 10,
    });
    const high = processFixture(72, {
      name: "high",
      parentPid: 70,
      cpuPercent: 90,
    });
    const processes = [low, root, high];
    const expanded = new Set([processIdentity(root)]);

    expect(
      project(processes, {
        sortKey: "cpu",
        direction: "descending",
        expanded,
      }).rows.map((row) => row.process.name),
    ).toEqual(["root", "high", "low"]);
    expect(
      project(processes, {
        sortKey: "cpu",
        direction: "ascending",
        expanded,
      }).rows.map((row) => row.process.name),
    ).toEqual(["root", "low", "high"]);
  });

  it("uses stable identity ordering when nullable metrics are unavailable", () => {
    const alpha = processFixture(73, {
      birthToken: "alpha",
      cpuPercent: null,
      diskReadBytesPerSecond: null,
      diskWriteBytesPerSecond: null,
    });
    const beta = processFixture(74, {
      birthToken: "beta",
      cpuPercent: null,
      diskReadBytesPerSecond: null,
      diskWriteBytesPerSecond: null,
    });
    const signatures = ([alpha, beta] as ProcessRow[]).map(processIdentity).sort();

    for (const sortKey of ["cpu", "disk"] as const) {
      expect(
        project([beta, alpha], { sortKey, direction: "descending" }).rows.map(
          (row) => row.identity,
        ),
      ).toEqual(signatures);
      expect(
        project([alpha, beta], { sortKey, direction: "ascending" }).rows.map(
          (row) => row.identity,
        ),
      ).toEqual(signatures);
    }
  });

  it("keeps matching rows and their ancestors while excluding unrelated branches", () => {
    const root = processFixture(80, { name: "init" });
    const branch = processFixture(81, { name: "shell", parentPid: 80 });
    const leaf = processFixture(82, { name: "needle-worker", parentPid: 81 });
    const unrelated = processFixture(83, { name: "database", parentPid: 80 });
    const projection = project([unrelated, leaf, root, branch], { query: "needle" });

    expect(projection.rows.map((row) => row.process.name)).toEqual([
      "init",
      "shell",
      "needle-worker",
    ]);
    expect(projection.rows.map((row) => row.queryMatch)).toEqual([false, false, true]);
    expect(projection.includedCount).toBe(3);
    expect(projection.matchCount).toBe(1);
  });

  it("temporarily expands selected ancestors only when following is enabled", () => {
    const root = processFixture(90, { name: "root" });
    const branch = processFixture(91, { name: "branch", parentPid: 90 });
    const leaf = processFixture(92, { name: "leaf", parentPid: 91 });
    const processes = [root, branch, leaf];
    const selectedIdentity = processIdentity(leaf);

    expect(
      project(processes, { selectedIdentity, followSelection: false }).rows.map(
        (row) => row.process.name,
      ),
    ).toEqual(["root"]);
    expect(
      project(processes, { selectedIdentity, followSelection: true }).rows.map(
        (row) => row.process.name,
      ),
    ).toEqual(["root", "branch", "leaf"]);
  });

  it("projects a 5,000-level expanded chain without recursive stack overflow", () => {
    const processes = Array.from({ length: 5_000 }, (_, index) =>
      processFixture(index + 1, {
        parentPid: index === 0 ? null : index,
        name: `chain-${index + 1}`,
      }),
    );

    const projection = project(processes, { expanded: expandAll(processes) });

    expect(projection.rows).toHaveLength(processes.length);
    expect(projection.rows[projection.rows.length - 1]?.depth).toBe(4_999);
  });
});

describe("selected process history", () => {
  it("resets the series when selection identity changes", () => {
    const first = processFixture(101, { name: "first", cpuPercent: 10 });
    const second = processFixture(102, { name: "second", cpuPercent: 20 });
    const firstHistory = updateSelectedProcessHistory(
      null,
      snapshotFixture(1, 1_000, [first, second]),
      processIdentity(first),
    );
    const secondHistory = updateSelectedProcessHistory(
      firstHistory,
      snapshotFixture(2, 2_000, [first, second]),
      processIdentity(second),
    );

    expect(secondHistory?.identity).toBe(processIdentity(second));
    expect(secondHistory?.name).toBe("second");
    expect(secondHistory?.points.map((point) => point.sequence)).toEqual([2]);
  });

  it("freezes points and marks the series missing when the process disappears", () => {
    const process = processFixture(103, { cpuPercent: 33 });
    const history = updateSelectedProcessHistory(
      null,
      snapshotFixture(1, 1_000, [process]),
      processIdentity(process),
    );
    const missing = updateSelectedProcessHistory(
      history,
      snapshotFixture(2, 2_000, []),
      processIdentity(process),
    );
    const stillMissing = updateSelectedProcessHistory(
      missing,
      snapshotFixture(3, 3_000, []),
      processIdentity(process),
    );

    expect(missing?.missing).toBe(true);
    expect(missing?.points).toBe(history?.points);
    expect(stillMissing).toBe(missing);
  });

  it("ignores duplicate and out-of-order snapshot sequences", () => {
    const process = processFixture(104, { cpuPercent: 10 });
    const identity = processIdentity(process);
    const history = updateSelectedProcessHistory(
      null,
      snapshotFixture(10, 10_000, [process]),
      identity,
    );
    const changed = { ...process, cpuPercent: 99 };

    expect(
      updateSelectedProcessHistory(
        history,
        snapshotFixture(10, 11_000, [changed]),
        identity,
      ),
    ).toBe(history);
    expect(
      updateSelectedProcessHistory(
        history,
        snapshotFixture(9, 12_000, [changed]),
        identity,
      ),
    ).toBe(history);
  });

  it("retains exactly the rolling five-minute time window", () => {
    const process = processFixture(105);
    const identity = processIdentity(process);
    let history = updateSelectedProcessHistory(
      null,
      snapshotFixture(1, 1_000, [process]),
      identity,
    );
    history = updateSelectedProcessHistory(
      history,
      snapshotFixture(2, 1_000 + PROCESS_HISTORY_WINDOW_MS, [process]),
      identity,
    );
    expect(history?.points.map((point) => point.sequence)).toEqual([1, 2]);

    history = updateSelectedProcessHistory(
      history,
      snapshotFixture(3, 1_001 + PROCESS_HISTORY_WINDOW_MS, [process]),
      identity,
    );
    expect(history?.points.map((point) => point.sequence)).toEqual([2, 3]);
  });

  it("caps dense sampling at 300 points", () => {
    const process = processFixture(106);
    const identity = processIdentity(process);
    let history = null;
    for (let sequence = 1; sequence <= MAX_PROCESS_HISTORY_POINTS + 5; sequence += 1) {
      history = updateSelectedProcessHistory(
        history,
        snapshotFixture(sequence, 10_000 + sequence, [process]),
        identity,
      );
    }

    expect(history?.points).toHaveLength(MAX_PROCESS_HISTORY_POINTS);
    expect(history?.points[0]?.sequence).toBe(6);
    expect(history?.points[history.points.length - 1]?.sequence).toBe(305);
  });

  it("preserves null CPU and I/O samples instead of coercing them to zero", () => {
    const process = processFixture(107, {
      cpuPercent: null,
      memoryBytes: 12_345,
      diskReadBytesPerSecond: null,
      diskWriteBytesPerSecond: null,
    });
    const history = updateSelectedProcessHistory(
      null,
      snapshotFixture(1, 1_000, [process]),
      processIdentity(process),
    );

    expect(history?.points[0]).toMatchObject({
      cpuPercent: null,
      memoryBytes: 12_345,
      diskReadBytesPerSecond: null,
      diskWriteBytesPerSecond: null,
    });
  });

  it("does not append a replacement process that reused the same PID", () => {
    const original = processFixture(108, {
      birthToken: "original-token",
      cpuPercent: 10,
    });
    const replacement = processFixture(108, {
      birthToken: "replacement-token",
      cpuPercent: 90,
    });
    const originalIdentity = processIdentity(original);
    const replacementIdentity = processIdentity(replacement);
    const history = updateSelectedProcessHistory(
      null,
      snapshotFixture(1, 1_000, [original]),
      originalIdentity,
    );
    const originalMissing = updateSelectedProcessHistory(
      history,
      snapshotFixture(2, 2_000, [replacement]),
      originalIdentity,
    );

    expect(originalMissing?.missing).toBe(true);
    expect(originalMissing?.points.map((point) => point.cpuPercent)).toEqual([10]);

    const replacementHistory = updateSelectedProcessHistory(
      originalMissing,
      snapshotFixture(2, 2_000, [replacement]),
      replacementIdentity,
    );
    expect(replacementHistory?.identity).toBe(replacementIdentity);
    expect(replacementHistory?.points.map((point) => point.cpuPercent)).toEqual([90]);
  });
});

describe("process history chart segmentation", () => {
  const historyPoint = (sequence: number, timestamp: number): ProcessHistoryPoint => ({
    sequence,
    timestamp,
    cpuPercent: sequence * 10,
    memoryBytes: sequence * 1_024,
    diskReadBytesPerSecond: sequence * 100,
    diskWriteBytesPerSecond: sequence * 50,
  });

  it("keeps normal samples connected and breaks across a sampling gap", () => {
    const continuousPoints = [historyPoint(1, 0), historyPoint(2, 1_000)];
    const gapPoints = [historyPoint(1, 0), historyPoint(2, 6_001)];

    const continuous = buildProcessHistoryLineSegments(
      continuousPoints,
      [10, 20],
      0,
      10_000,
      100,
    );
    const withGap = buildProcessHistoryLineSegments(
      gapPoints,
      [10, 20],
      0,
      10_000,
      100,
    );

    expect(continuous).toHaveLength(1);
    expect(continuous[0]).toContain("L");
    expect(withGap).toHaveLength(2);
    expect(withGap.every((path) => !path.includes("L"))).toBe(true);
  });
});

describe("virtual range", () => {
  it("projects a bounded middle window for 5,000 rows", () => {
    const range = computeVirtualRange(5_000, 36, 90_000, 720, 5);

    expect(range).toEqual({
      start: 2_495,
      end: 2_525,
      paddingTop: 2_495 * 36,
      paddingBottom: (5_000 - 2_525) * 36,
    });
    expect(range.end - range.start).toBe(30);
  });

  it("clamps a scroll position beyond the end while preserving total height", () => {
    const rowHeight = 36;
    const range = computeVirtualRange(5_000, rowHeight, 999_999, 720, 5);
    const renderedHeight = (range.end - range.start) * rowHeight;

    expect(range.start).toBe(4_975);
    expect(range.end).toBe(5_000);
    expect(range.paddingBottom).toBe(0);
    expect(range.paddingTop + renderedHeight + range.paddingBottom).toBe(
      5_000 * rowHeight,
    );
  });

  it("returns an empty range for invalid dimensions", () => {
    expect(computeVirtualRange(0, 36, 0, 720)).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
    expect(computeVirtualRange(5_000, Number.NaN, 0, 720)).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
  });
});
