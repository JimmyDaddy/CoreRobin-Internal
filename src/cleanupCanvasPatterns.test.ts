import { describe, expect, it, vi } from "vitest";

import { cleanupHatchPattern } from "./cleanupCanvasPatterns";

function fakeContext() {
  const pattern = { setTransform: vi.fn() } as unknown as CanvasPattern;
  const context = {
    createPattern: vi.fn(() => pattern),
  } as unknown as CanvasRenderingContext2D;
  return { context, pattern };
}

describe("cleanup canvas hatch patterns", () => {
  it("reuses a pattern for the same context, theme, color, and DPR", () => {
    const { context, pattern } = fakeContext();
    const createSource = vi.fn(() => ({}) as CanvasImageSource);
    const options = {
      color: "rgba(255, 125, 115, 0.62)",
      lineWidth: 2.4,
      pixelRatio: 2,
      spacing: 11,
      themeKey: "dark",
    };

    expect(cleanupHatchPattern(context, options, createSource)).toBe(pattern);
    expect(cleanupHatchPattern(context, options, createSource)).toBe(pattern);

    expect(createSource).toHaveBeenCalledTimes(1);
    expect(context.createPattern).toHaveBeenCalledTimes(1);
    expect(pattern.setTransform).toHaveBeenCalledWith({
      a: 0.5,
      b: 0,
      c: 0,
      d: 0.5,
      e: 0,
      f: 0,
    });
  });

  it("creates distinct patterns for theme, color, and DPR changes", () => {
    const { context } = fakeContext();
    const createSource = vi.fn(() => ({}) as CanvasImageSource);
    const base = {
      color: "red",
      lineWidth: 2,
      pixelRatio: 1,
      spacing: 11,
      themeKey: "dark",
    };

    cleanupHatchPattern(context, base, createSource);
    cleanupHatchPattern(context, { ...base, themeKey: "light" }, createSource);
    cleanupHatchPattern(context, { ...base, color: "purple" }, createSource);
    cleanupHatchPattern(context, { ...base, pixelRatio: 2 }, createSource);

    expect(createSource).toHaveBeenCalledTimes(4);
    expect(context.createPattern).toHaveBeenCalledTimes(4);
  });
});
