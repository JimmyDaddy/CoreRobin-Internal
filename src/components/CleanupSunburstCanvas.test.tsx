/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLEANUP_MAP_MAX_ARCS, type CleanupMapArc } from "../cleanupMap";
import { CleanupSunburstCanvas } from "./CleanupSunburstCanvas";

const stroke = vi.fn();
const drawImage = vi.fn();

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  let globalAlpha = 1;
  const alphaStack: number[] = [];
  return {
    canvas,
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
    },
    save: vi.fn(() => alphaStack.push(globalAlpha)),
    restore: vi.fn(() => {
      globalAlpha = alphaStack.pop() ?? 1;
    }),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    stroke,
    setLineDash: vi.fn(),
    drawImage,
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    createPattern: vi.fn(() => ({ setTransform: vi.fn() }) as unknown as CanvasPattern),
  } as unknown as CanvasRenderingContext2D;
}

function arc(index: number): CleanupMapArc {
  const startAngle = -Math.PI / 2 + (index / CLEANUP_MAP_MAX_ARCS) * Math.PI * 2;
  return {
    node: {
      id: `node-${index}`,
      name: `Node ${index}`,
      path: `/tmp/node-${index}`,
      sizeBytes: 1,
      logicalSizeBytes: 1,
      allocatedSizeBytes: 1,
      itemCount: 1,
      safety: "reclaimable",
      kind: "folder",
      hasChildren: false,
      children: [],
    },
    depth: 1,
    startAngle,
    endAngle: startAngle + (Math.PI * 2) / CLEANUP_MAP_MAX_ARCS,
    innerRadius: 53,
    outerRadius: 85,
  };
}

const arcs = Array.from({ length: CLEANUP_MAP_MAX_ARCS }, (_, index) => arc(index));
const collectedIds = new Set(arcs.map(({ node }) => node.id));
const baseProps = {
  arcs,
  hues: new Map<string, number>(),
  selectedId: "",
  changedIds: new Set<string>(),
  collectedIds,
  focusKey: "root",
  ariaLabel: "cleanup map",
  onSelect: vi.fn(),
  onActivate: vi.fn(),
  onCollect: vi.fn(),
  onPointerDown: vi.fn(),
  onPointerCancel: vi.fn(),
};

beforeEach(() => {
  stroke.mockClear();
  drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function getContext(this: HTMLCanvasElement) {
      return contextFor(this);
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 420,
    height: 420,
    top: 0,
    right: 420,
    bottom: 420,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 2,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true })),
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
  });
  vi.stubGlobal("ResizeObserver", window.ResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CleanupSunburstCanvas collected overlay", () => {
  it("uses bounded strokes for 640 collected arcs and reuses the collected layer", () => {
    const { rerender } = render(<CleanupSunburstCanvas {...baseProps} />);

    expect(stroke.mock.calls.length).toBeLessThanOrEqual(1_300);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const initialStrokeCount = stroke.mock.calls.length;

    rerender(
      <CleanupSunburstCanvas {...baseProps} selectedId="node-42" />,
    );

    expect(stroke.mock.calls.length - initialStrokeCount).toBeLessThanOrEqual(650);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it("shows a local size tooltip while an arc is hovered", () => {
    render(<CleanupSunburstCanvas {...baseProps} collectedIds={new Set()} />);

    const canvas = screen.getByRole("img", { name: "cleanup map" });
    fireEvent.pointerMove(canvas, { clientX: 210.35, clientY: 140 });

    expect(screen.getByText("Node 0")).toBeTruthy();
    expect(screen.getByText(/1 B · 0.2%/)).toBeTruthy();
  });
});
