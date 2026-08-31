import { describe, expect, it } from "vitest";
import { formatColor, parseColor } from "./colorTools";

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

  it("detects P3 gamut from the raw conversion before clipping to sRGB", () => {
    const color = parseColor("color(display-p3 1 0 0)");
    expect(color.gamutMapped).toBe(true);
    expect(color.r).toBe(1);
    expect(color.g).toBe(0);
    expect(color.b).toBe(0);
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
