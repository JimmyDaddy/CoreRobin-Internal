/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import i18n from "../i18n";
import type { ProcessRow } from "../types";
import { ProcessTable } from "./ProcessTable";

vi.mock("./ApplicationAvatar", () => ({
  ApplicationAvatar: ({ name }: { name: string }) => (
    <span aria-hidden="true">{name.slice(0, 1)}</span>
  ),
}));

beforeEach(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      disconnect() {}
    },
  );
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function processFixture(pid: number, name: string, cpuPercent: number): ProcessRow {
  return {
    pid,
    birthToken: `fixture:${pid}`,
    parentPid: null,
    startTime: 1_000 + pid,
    runTimeSeconds: 60,
    name,
    user: "tester",
    status: "Run",
    cpuPercent,
    memoryBytes: 1_000,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    protected: false,
  };
}

function processNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      ".process-row .process-select-button",
    ),
    (button) => button.textContent ?? "",
  );
}

function table(
  processes: ProcessRow[],
  liveSort: boolean,
  onLiveSortChange = vi.fn(),
) {
  return (
    <ProcessTable
      processes={processes}
      selectedIdentity={null}
      onSelect={() => undefined}
      query=""
      onQueryChange={() => undefined}
      sortKey="cpu"
      direction="descending"
      onSortChange={() => undefined}
      liveSort={liveSort}
      onLiveSortChange={onLiveSortChange}
    />
  );
}

function SearchHarness({ initialQuery = "node" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <ProcessTable
      processes={[processFixture(1, "node", 10)]}
      selectedIdentity={null}
      onSelect={() => undefined}
      query={query}
      onQueryChange={setQuery}
      sortKey="cpu"
      direction="descending"
      onSortChange={() => undefined}
      liveSort={false}
    />
  );
}

describe("process table sorting mode", () => {
  const initial = [
    processFixture(1, "Alpha", 90),
    processFixture(2, "Beta", 10),
  ];
  const changed = [
    processFixture(1, "Alpha", 5),
    processFixture(2, "Beta", 95),
  ];

  it("keeps a single sorted order while live sorting is off", () => {
    const view = render(table(initial, false));
    expect(processNames(view.container)).toEqual(["Alpha", "Beta"]);

    view.rerender(table(changed, false));
    expect(processNames(view.container)).toEqual(["Alpha", "Beta"]);
  });

  it("reorders on new samples while live sorting is on", () => {
    const view = render(table(initial, true));
    expect(processNames(view.container)).toEqual(["Alpha", "Beta"]);

    view.rerender(table(changed, true));
    expect(processNames(view.container)).toEqual(["Beta", "Alpha"]);
  });

  it("lets the user toggle live sorting", () => {
    const onLiveSortChange = vi.fn();
    render(table(initial, false, onLiveSortChange));

    fireEvent.click(screen.getByRole("button", { name: "实时排序" }));

    expect(onLiveSortChange).toHaveBeenCalledWith(true);
  });

  it("allows typing, deleting, clearing, and escaping the process filter", () => {
    render(<SearchHarness />);
    const input = screen.getByRole("textbox", { name: "搜索进程" }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "清除进程筛选" }));
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "8080" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("clears the filter when restoring the default process view", () => {
    const onQueryChange = vi.fn();
    render(
      <ProcessTable
        processes={initial}
        selectedIdentity={null}
        onSelect={() => undefined}
        query="node"
        onQueryChange={onQueryChange}
        sortKey="cpu"
        direction="descending"
        onSortChange={() => undefined}
        liveSort={false}
        onResetPreferences={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "恢复默认进程视图" }));
    expect(onQueryChange).toHaveBeenCalledWith("");
  });
});
