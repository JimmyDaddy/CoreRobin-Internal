import { ToolboxInputError } from "../local/toolboxErrors";

export interface ColorValue {
  r: number;
  g: number;
  b: number;
  a: number;
  source: string;
  gamutMapped: boolean;
}

const NAMED: Record<string, string> = { red: "#ff0000", green: "#008000", blue: "#0000ff", white: "#ffffff", black: "#000000", transparent: "#00000000", rebeccapurple: "#663399", orange: "#ffa500", yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff" };

export function parseColor(input: string): ColorValue {
  const value = input.trim().toLowerCase();
  const named = NAMED[value];
  if (named) return parseHex(named, input);
  if (value.startsWith("#")) return parseHex(value, input);
  let match = value.match(/^rgba?\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)(?:\s*,\s*([^,]+))?\s*\)$/);
  if (match) return { r: channel(match[1]), g: channel(match[2]), b: channel(match[3]), a: alpha(match[4]), source: input, gamutMapped: false };
  match = value.match(/^hsla?\(\s*([^,]+)\s*,\s*([^,]+)%\s*,\s*([^,]+)%(?:\s*,\s*([^,]+))?\s*\)$/);
  if (match) {
    const rgb = hslToRgb(Number.parseFloat(match[1]) / 360, Number.parseFloat(match[2]) / 100, Number.parseFloat(match[3]) / 100);
    return { ...rgb, a: alpha(match[4]), source: input, gamutMapped: false };
  }
  match = value.match(/^hsv\(\s*([^,]+)\s*,\s*([^,]+)%\s*,\s*([^,]+)%(?:\s*,\s*([^,]+))?\s*\)$/);
  if (match) {
    const rgb = hsvToRgb(Number.parseFloat(match[1]) / 360, Number.parseFloat(match[2]) / 100, Number.parseFloat(match[3]) / 100);
    return { ...rgb, a: alpha(match[4]), source: input, gamutMapped: false };
  }
  match = value.match(/^oklch\(\s*([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\/\s*([^\s]+))?\s*\)$/);
  if (match) {
    const lightness = Number.parseFloat(match[1]);
    const chroma = Number.parseFloat(match[2]);
    const hue = Number.parseFloat(match[3]) * Math.PI / 180;
    const lab = { l: lightness, a: chroma * Math.cos(hue), b: chroma * Math.sin(hue) };
    const mapped = mapToSrgb(oklabToRgb(lab.l, lab.a, lab.b));
    return { ...mapped.rgb, a: alpha(match[4]), source: input, gamutMapped: mapped.gamutMapped };
  }
  match = value.match(/^color\(display-p3\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\/\s*([^\s]+))?\)$/);
  if (match) {
    const p3 = [Number.parseFloat(match[1]), Number.parseFloat(match[2]), Number.parseFloat(match[3])];
    const rawRgb = { r: 1.2247 * p3[0] - 0.2249 * p3[1], g: -0.042 * p3[0] + 1.042 * p3[1], b: -0.0196 * p3[0] - 0.0786 * p3[1] + 1.0985 * p3[2] };
    const mapped = mapToSrgb(rawRgb);
    return { ...mapped.rgb, a: alpha(match[4]), source: input, gamutMapped: mapped.gamutMapped };
  }
  throw new ToolboxInputError("invalid_color", "无法识别颜色格式；支持 HEX、RGB、HSL、HSV、OKLCH 和 Display-P3。 ");
}

export function formatColor(color: ColorValue): Record<string, string> {
  const hsl = rgbToHsl(color.r, color.g, color.b);
  const hsv = rgbToHsv(color.r, color.g, color.b);
  const oklch = rgbToOklch(color.r, color.g, color.b);
  return {
    hex: `#${rgbHex(color.r, color.g, color.b)}${color.a < 1 ? byteHex(color.a) : ""}`,
    rgb: `rgb(${byte(color.r)} ${byte(color.g)} ${byte(color.b)}${color.a < 1 ? ` / ${round(color.a, 3)}` : ""})`,
    hsl: `hsl(${round(hsl.h * 360, 2)} ${round(hsl.s * 100, 2)}% ${round(hsl.l * 100, 2)}%${color.a < 1 ? ` / ${round(color.a, 3)}` : ""})`,
    hsv: `hsv(${round(hsv.h * 360, 2)} ${round(hsv.s * 100, 2)}% ${round(hsv.v * 100, 2)}%${color.a < 1 ? ` / ${round(color.a, 3)}` : ""})`,
    oklch: `oklch(${round(oklch.l, 4)} ${round(oklch.c, 4)} ${round(oklch.h, 2)}${color.a < 1 ? ` / ${round(color.a, 3)}` : ""})`,
  };
}

function parseHex(value: string, source: string): ColorValue {
  const hex = value.slice(1);
  if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/.test(hex)) throw new ToolboxInputError("invalid_color", "HEX 颜色格式无效。 ");
  const expanded = hex.length < 5 ? [...hex].map((char) => char + char).join("") : hex;
  return { r: Number.parseInt(expanded.slice(0, 2), 16) / 255, g: Number.parseInt(expanded.slice(2, 4), 16) / 255, b: Number.parseInt(expanded.slice(4, 6), 16) / 255, a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1, source, gamutMapped: false };
}
function channel(value: string): number { const numeric = value.trim().endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value) / 255; if (!Number.isFinite(numeric)) throw new ToolboxInputError("invalid_color", "RGB 通道值无效。 "); return clamp(numeric, 0, 1); }
function alpha(value: string | undefined): number { if (!value) return 1; const parsed = value.trim().endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value); if (!Number.isFinite(parsed)) throw new ToolboxInputError("invalid_color", "透明度无效。 "); return clamp(parsed, 0, 1); }
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } { const q = l < .5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; return { r: hue(p, q, h + 1 / 3), g: hue(p, q, h), b: hue(p, q, h - 1 / 3) }; }
function hue(p: number, q: number, t: number): number { let v = t; if (v < 0) v += 1; if (v > 1) v -= 1; if (v < 1 / 6) return p + (q - p) * 6 * v; if (v < 1 / 2) return q; if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6; return p; }
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } { const i = Math.floor(h * 6); const f = h * 6 - i; const p = v * (1 - s); const q = v * (1 - f * s); const t = v * (1 - (1 - f) * s); const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; return { r, g, b }; }
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } { const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; if (max === min) return { h: 0, s: 0, l }; const d = max - min; const s = l > .5 ? d / (2 - max - min) : d / (max + min); const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h / 6, s, l }; }
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } { const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min; if (!d) return { h: 0, s: 0, v: max }; const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h / 6, s: d / max, v: max }; }
function oklabToRgb(l: number, a: number, b: number): { r: number; g: number; b: number } { const l1 = Math.cbrt(l + 0.3963377774 * a + 0.2158037573 * b); const m1 = Math.cbrt(l - 0.1055613458 * a - 0.0638541728 * b); const s1 = Math.cbrt(l - 0.0894841775 * a - 1.291485548 * b); return { r: 4.0767416621 * l1 ** 3 - 3.3077115913 * m1 ** 3 + 0.2309699292 * s1 ** 3, g: -1.2684380046 * l1 ** 3 + 2.6097574011 * m1 ** 3 - 0.3413193965 * s1 ** 3, b: -0.0041960863 * l1 ** 3 - 0.7034186147 * m1 ** 3 + 1.707614701 * s1 ** 3 }; }
function rgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: lightness, c: Math.sqrt(a * a + labB * labB), h: (Math.atan2(labB, a) * 180 / Math.PI + 360) % 360 };
}
function inGamut(color: { r: number; g: number; b: number }): boolean { return [color.r, color.g, color.b].every((value) => value >= 0 && value <= 1); }
function mapToSrgb(raw: { r: number; g: number; b: number }): { rgb: { r: number; g: number; b: number }; gamutMapped: boolean } {
  const gamutMapped = !inGamut(raw);
  return { rgb: gamutMapped ? { r: clamp(raw.r, 0, 1), g: clamp(raw.g, 0, 1), b: clamp(raw.b, 0, 1) } : raw, gamutMapped };
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function byte(value: number): number { return Math.round(clamp(value, 0, 1) * 255); }
function byteHex(value: number): string { return byte(value).toString(16).padStart(2, "0"); }
function rgbHex(r: number, g: number, b: number): string { return `${byteHex(r)}${byteHex(g)}${byteHex(b)}`; }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
