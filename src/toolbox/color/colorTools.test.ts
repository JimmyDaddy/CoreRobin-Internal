import { describe, expect, it } from "vitest";
import { MAX_COLOR_INPUT_BYTES, formatColor, parseColor } from "./colorTools";
import { ToolboxInputError } from "../local/toolboxErrors";

function inputError(action: () => unknown): ToolboxInputError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolboxInputError);
    return error as ToolboxInputError;
  }
  throw new Error("Expected ToolboxInputError");
}

describe("color toolbox", () => {
  it("keeps alpha and represents gray without a fake hue", () => {
    const color = parseColor("#80808080");
    const output = formatColor(color);
    expect(output.hex).toBe("#80808080");
    expect(output.hsl).toContain("0 0%");
  });

  it("accepts all declared color families", () => {
    for (const value of ["rgb(255, 0, 0)", "hsl(0, 100%, 50%)", "hsv(0, 100%, 100%)", "oklch(0.6 0.1 30)", "color(display-p3 1 0 0)"]) {
      expect(parseColor(value).source).toBe(value);
    }
  });

  it("supports the standard named-color set, including aliases", () => {
    expect(formatColor(parseColor("cornflowerblue")).hex).toBe("#6495ed");
    expect(formatColor(parseColor("darkgrey")).hex).toBe("#a9a9a9");
    expect(formatColor(parseColor("transparent")).hex).toBe("#00000000");
  });

  it("rejects oversized, dirty, non-finite, and out-of-range color input", () => {
    expect(inputError(() => parseColor(" ".repeat(MAX_COLOR_INPUT_BYTES + 1))).code).toBe("input_too_large");

    for (const value of [
      "rgb(NaN, 0, 0)",
      "rgb(12px, 0, 0)",
      "rgb(256, 0, 0)",
      "rgba(0, 0, 0, 1.01)",
      "hsl(361, 50%, 50%)",
      "hsv(0, 101%, 50%)",
      "oklch(1.01 0.1 30)",
      "color(display-p3 1.01 0 0)",
    ]) {
      expect(inputError(() => parseColor(value)).code).toBe("invalid_color");
    }
  });

  it("detects P3 gamut from the raw conversion before clipping to sRGB", () => {
    const color = parseColor("color(display-p3 1 0 0)");
    expect(color.gamutMapped).toBe(true);
    expect(color.r).toBe(1);
    expect(color.g).toBe(0);
    expect(color.b).toBe(0);
  });

  it("keeps in-gamut P3 values raw-equivalent and only flags actual mapping", () => {
    const color = parseColor("color(display-p3 50% 50% 50%)");
    expect(color.gamutMapped).toBe(false);
    expect(color.r).toBeCloseTo(0.5, 3);
    expect(color.g).toBeCloseTo(0.5, 3);
    expect(color.b).toBeCloseTo(0.5, 3);
  });

  it("clips out-of-gamut OKLCH conversion results after detecting gamut", () => {
    const color = parseColor("oklch(0.6 0.4 30)");
    expect(color.gamutMapped).toBe(true);
    expect(color.r).toBe(1);
    expect(color.g).toBeGreaterThanOrEqual(0);
    expect(color.g).toBeLessThanOrEqual(1);
    expect(color.b).toBeGreaterThanOrEqual(0);
    expect(color.b).toBeLessThanOrEqual(1);
  });
});
