import { ToolboxInputError } from "../local/toolboxErrors";

export interface ColorValue {
  r: number;
  g: number;
  b: number;
  a: number;
  source: string;
  gamutMapped: boolean;
}

export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export const MAX_COLOR_INPUT_BYTES = 4 * 1024;

const NAMED: Readonly<Record<string, string>> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4", azure: "#f0ffff", beige: "#f5f5dc", bisque: "#ffe4c4", black: "#000000", blanchedalmond: "#ffebcd", blue: "#0000ff", blueviolet: "#8a2be2", brown: "#a52a2a", burlywood: "#deb887",
  cadetblue: "#5f9ea0", chartreuse: "#7fff00", chocolate: "#d2691e", coral: "#ff7f50", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c", cyan: "#00ffff",
  darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b", darkgray: "#a9a9a9", darkgreen: "#006400", darkgrey: "#a9a9a9", darkkhaki: "#bdb76b", darkmagenta: "#8b008b", darkolivegreen: "#556b2f", darkorange: "#ff8c00", darkorchid: "#9932cc", darkred: "#8b0000", darksalmon: "#e9967a", darkseagreen: "#8fbc8f", darkslateblue: "#483d8b", darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1", darkviolet: "#9400d3", deeppink: "#ff1493", deepskyblue: "#00bfff", dimgray: "#696969", dimgrey: "#696969", dodgerblue: "#1e90ff",
  firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22", fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700", goldenrod: "#daa520", gray: "#808080", green: "#008000", greenyellow: "#adff2f", grey: "#808080",
  honeydew: "#f0fff0", hotpink: "#ff69b4", indianred: "#cd5c5c", indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c",
  lavender: "#e6e6fa", lavenderblush: "#fff0f5", lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6", lightcoral: "#f08080", lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3", lightgreen: "#90ee90", lightgrey: "#d3d3d3", lightpink: "#ffb6c1", lightsalmon: "#ffa07a", lightseagreen: "#20b2aa", lightskyblue: "#87cefa", lightslategray: "#778899", lightslategrey: "#778899", lightsteelblue: "#b0c4de", lightyellow: "#ffffe0", lime: "#00ff00", limegreen: "#32cd32", linen: "#faf0e6",
  magenta: "#ff00ff", maroon: "#800000", mediumaquamarine: "#66cdaa", mediumblue: "#0000cd", mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371", mediumslateblue: "#7b68ee", mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc", mediumvioletred: "#c71585", midnightblue: "#191970", mintcream: "#f5fffa", mistyrose: "#ffe4e1", moccasin: "#ffe4b5",
  navajowhite: "#ffdead", navy: "#000080", oldlace: "#fdf5e6", olive: "#808000", olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500", orchid: "#da70d6",
  palegoldenrod: "#eee8aa", palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093", papayawhip: "#ffefd5", peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb", plum: "#dda0dd", powderblue: "#b0e0e6", purple: "#800080",
  rebeccapurple: "#663399", red: "#ff0000", rosybrown: "#bc8f8f", royalblue: "#4169e1",
  saddlebrown: "#8b4513", salmon: "#fa8072", sandybrown: "#f4a460", seagreen: "#2e8b57", seashell: "#fff5ee", sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd", slategray: "#708090", slategrey: "#708090", snow: "#fffafa", springgreen: "#00ff7f", steelblue: "#4682b4",
  tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8", tomato: "#ff6347", transparent: "#00000000", turquoise: "#40e0d0",
  violet: "#ee82ee", wheat: "#f5deb3", white: "#ffffff", whitesmoke: "#f5f5f5", yellow: "#ffff00", yellowgreen: "#9acd32",
};

const NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

export function parseColor(input: string): ColorValue {
  assertColorInputLimit(input);
  const value = input.trim().toLowerCase();
  const named = NAMED[value];
  if (named) return parseHex(named, input);
  if (value.startsWith("#")) return parseHex(value, input);
  let match = value.match(/^rgba?\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)(?:\s*,\s*([^,]+))?\s*\)$/);
  if (match) return { r: channel(match[1]), g: channel(match[2]), b: channel(match[3]), a: alpha(match[4]), source: input, gamutMapped: false };
  match = value.match(/^hsla?\(\s*([^,]+)\s*,\s*([^,]+)%\s*,\s*([^,]+)%(?:\s*,\s*([^,]+))?\s*\)$/);
  if (match) {
    const rgb = hslToRgb(hueComponent(match[1]), percentage(match[2], "HSL 饱和度"), percentage(match[3], "HSL 亮度"));
    return { ...rgb, a: alpha(match[4]), source: input, gamutMapped: false };
  }
  match = value.match(/^hsv\(\s*([^,]+)\s*,\s*([^,]+)%\s*,\s*([^,]+)%(?:\s*,\s*([^,]+))?\s*\)$/);
  if (match) {
    const rgb = hsvToRgb(hueComponent(match[1]), percentage(match[2], "HSV 饱和度"), percentage(match[3], "HSV 明度"));
    return { ...rgb, a: alpha(match[4]), source: input, gamutMapped: false };
  }
  match = value.match(/^oklch\(\s*([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\/\s*([^\s]+))?\s*\)$/);
  if (match) {
    const lightness = normalized(match[1], "OKLCH 亮度");
    const chroma = boundedNumber(match[2], 0, 0.5, "OKLCH 色度");
    const hue = hueDegrees(match[3]) * Math.PI / 180;
    const lab = { l: lightness, a: chroma * Math.cos(hue), b: chroma * Math.sin(hue) };
    const mapped = mapToSrgb(oklabToRgb(lab.l, lab.a, lab.b));
    return { ...mapped.rgb, a: alpha(match[4]), source: input, gamutMapped: mapped.gamutMapped };
  }
  match = value.match(/^color\(display-p3\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s*\/\s*([^\s]+))?\)$/);
  if (match) {
    const p3 = [normalized(match[1], "Display-P3 红色通道"), normalized(match[2], "Display-P3 绿色通道"), normalized(match[3], "Display-P3 蓝色通道")] as const;
    const mapped = mapToSrgb(displayP3ToSrgb(p3));
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

export function colorFromHsv(h: number, s: number, v: number, a = 1, source = ""): ColorValue {
  const normalizedHue = ((h % 360) + 360) % 360 / 360;
  const rgb = hsvToRgb(normalizedHue, clamp(s, 0, 1), clamp(v, 0, 1));
  return { ...rgb, a: clamp(a, 0, 1), source, gamutMapped: false };
}

export function colorToHsv(color: ColorValue): HsvColor {
  const hsv = rgbToHsv(color.r, color.g, color.b);
  return { h: hsv.h * 360, s: hsv.s, v: hsv.v };
}

export function contrastRatio(foreground: ColorValue, background: ColorValue): number {
  const composited = {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  };
  const foregroundLuminance = relativeLuminance(composited);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHex(value: string, source: string): ColorValue {
  const hex = value.slice(1);
  if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/.test(hex)) throw new ToolboxInputError("invalid_color", "HEX 颜色格式无效。 ");
  const expanded = hex.length < 5 ? [...hex].map((char) => char + char).join("") : hex;
  return { r: Number.parseInt(expanded.slice(0, 2), 16) / 255, g: Number.parseInt(expanded.slice(2, 4), 16) / 255, b: Number.parseInt(expanded.slice(4, 6), 16) / 255, a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1, source, gamutMapped: false };
}
function assertColorInputLimit(value: string): void { if (new TextEncoder().encode(value).byteLength > MAX_COLOR_INPUT_BYTES) throw new ToolboxInputError("input_too_large", "颜色输入不能超过 4 KiB。 "); }
function invalidColor(message: string): never { throw new ToolboxInputError("invalid_color", message); }
function numeric(value: string, message: string): number { const trimmed = value.trim(); if (!NUMBER.test(trimmed)) return invalidColor(message); const parsed = Number(trimmed); return Number.isFinite(parsed) ? parsed : invalidColor(message); }
function boundedNumber(value: string, min: number, max: number, label: string): number { const parsed = numeric(value, `${label}无效。 `); return parsed >= min && parsed <= max ? parsed : invalidColor(`${label}无效。 `); }
function normalized(value: string, label: string): number { const trimmed = value.trim(); if (trimmed.endsWith("%")) return boundedNumber(trimmed.slice(0, -1), 0, 100, label) / 100; return boundedNumber(trimmed, 0, 1, label); }
function percentage(value: string, label: string): number { return boundedNumber(value, 0, 100, label) / 100; }
function hueDegrees(value: string): number { return boundedNumber(value, 0, 360, "色相"); }
function hueComponent(value: string): number { return hueDegrees(value) / 360; }
function channel(value: string): number { const trimmed = value.trim(); if (trimmed.endsWith("%")) return boundedNumber(trimmed.slice(0, -1), 0, 100, "RGB 通道值") / 100; return boundedNumber(trimmed, 0, 255, "RGB 通道值") / 255; }
function alpha(value: string | undefined): number { if (!value) return 1; return normalized(value, "透明度"); }
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } { const q = l < .5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; return { r: hue(p, q, h + 1 / 3), g: hue(p, q, h), b: hue(p, q, h - 1 / 3) }; }
function hue(p: number, q: number, t: number): number { let v = t; if (v < 0) v += 1; if (v > 1) v -= 1; if (v < 1 / 6) return p + (q - p) * 6 * v; if (v < 1 / 2) return q; if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6; return p; }
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } { const i = Math.floor(h * 6); const f = h * 6 - i; const p = v * (1 - s); const q = v * (1 - f * s); const t = v * (1 - (1 - f) * s); const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; return { r, g, b }; }
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } { const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; if (max === min) return { h: 0, s: 0, l }; const d = max - min; const s = l > .5 ? d / (2 - max - min) : d / (max + min); const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h / 6, s, l }; }
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } { const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min; if (!d) return { h: 0, s: 0, v: max }; const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h / 6, s: d / max, v: max }; }
function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const linear = [r, g, b].map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
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
function displayP3ToSrgb([r, g, b]: readonly [number, number, number]): { r: number; g: number; b: number } {
  const linearP3 = [decodeTransfer(r), decodeTransfer(g), decodeTransfer(b)] as const;
  const linearSrgb = {
    r: 1.22474549 * linearP3[0] - 0.22490444 * linearP3[1],
    g: -0.04205808 * linearP3[0] + 1.042080996 * linearP3[1],
    b: -0.01964226 * linearP3[0] - 0.07865488 * linearP3[1] + 1.09853716 * linearP3[2],
  };
  return { r: encodeTransfer(linearSrgb.r), g: encodeTransfer(linearSrgb.g), b: encodeTransfer(linearSrgb.b) };
}
function decodeTransfer(value: number): number { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }
function encodeTransfer(value: number): number { return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055; }
function inGamut(color: { r: number; g: number; b: number }): boolean { return [color.r, color.g, color.b].every((value) => value >= -1e-7 && value <= 1 + 1e-7); }
function mapToSrgb(raw: { r: number; g: number; b: number }): { rgb: { r: number; g: number; b: number }; gamutMapped: boolean } {
  const gamutMapped = !inGamut(raw);
  return { rgb: { r: clamp(raw.r, 0, 1), g: clamp(raw.g, 0, 1), b: clamp(raw.b, 0, 1) }, gamutMapped };
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function byte(value: number): number { return Math.round(clamp(value, 0, 1) * 255); }
function byteHex(value: number): string { return byte(value).toString(16).padStart(2, "0"); }
function rgbHex(r: number, g: number, b: number): string { return `${byteHex(r)}${byteHex(g)}${byteHex(b)}`; }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
