import { Check, CircleAlert, Copy, Pipette, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { isMacOSDesktopRuntime, pickToolboxScreenColor } from "../../api";
import { colorFromHsv, colorToHsv, contrastRatio, formatColor, parseColor, type ColorValue } from "./colorTools";
import "./colorPicker.css";

type EyeDropperLike = new () => { open: () => Promise<{ sRGBHex: string }> };
type FormatKey = "hex" | "rgb" | "hsl" | "hsv" | "oklch";

const DEFAULT_COLOR = parseColor("#5b8def");
const WHITE = parseColor("#ffffff");
const BLACK = parseColor("#000000");
const FORMAT_FIELDS: ReadonlyArray<{ key: FormatKey; label: string }> = [
  { key: "hex", label: "HEX" },
  { key: "rgb", label: "RGB" },
  { key: "hsl", label: "HSL" },
  { key: "hsv", label: "HSV" },
  { key: "oklch", label: "OKLCH" },
];

export function ColorPickerTool() {
  const { t } = useTranslation("toolbox");
  const [color, setColor] = useState<ColorValue>(DEFAULT_COLOR);
  const [draft, setDraft] = useState(formatColor(DEFAULT_COLOR).hex);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [eyeDropper] = useState(() => detectEyeDropper());
  const [nativeScreenPicker] = useState(() => isMacOSDesktopRuntime());
  const [pickingFromScreen, setPickingFromScreen] = useState(false);
  const formats = useMemo(() => formatColor(color), [color]);
  const hsv = colorToHsv(color);
  const hueStyle = { "--color-picker-hue": `hsl(${hsv.h} 100% 50%)` } as CSSProperties;
  const lightContrast = contrastRatio(color, WHITE);
  const darkContrast = contrastRatio(color, BLACK);

  const applyColor = (next: ColorValue) => {
    setColor(next);
    setDraft(formatColor(next).hex);
    setError("");
    setNotice("");
  };

  const updateFromHsv = (nextHsv: { h: number; s: number; v: number }, alpha = color.a) => {
    applyColor(colorFromHsv(nextHsv.h, nextHsv.s, nextHsv.v, alpha, "picker"));
  };

  const updateSaturationValue = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const saturation = clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1);
    const value = clamp(1 - (event.clientY - bounds.top) / Math.max(bounds.height, 1), 0, 1);
    updateFromHsv({ h: hsv.h, s: saturation, v: value });
  };

  const handleSaturationValueKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let saturation = hsv.s;
    let value = hsv.v;
    if (event.key === "ArrowLeft") saturation -= step;
    else if (event.key === "ArrowRight") saturation += step;
    else if (event.key === "ArrowDown") value -= step;
    else if (event.key === "ArrowUp") value += step;
    else return;
    event.preventDefault();
    updateFromHsv({ h: hsv.h, s: clamp(saturation, 0, 1), v: clamp(value, 0, 1) });
  };

  const commitDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const next = parseColor(draft);
      applyColor(next);
      setNotice(t("local.colorPicker.applied"));
    } catch {
      setError(t("local.colorPicker.invalid"));
      setNotice("");
    }
  };

  const copyFormat = async (format: FormatKey) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(formats[format]);
      setError("");
      setNotice(t("local.colorPicker.copied", { format: FORMAT_FIELDS.find((field) => field.key === format)?.label ?? format }));
    } catch {
      setError(t("local.colorPicker.copyFailed"));
      setNotice("");
    }
  };

  const pickFromScreen = async () => {
    if (!eyeDropper && !nativeScreenPicker) return;
    setPickingFromScreen(true);
    setError("");
    setNotice("");
    try {
      const sampledHex = nativeScreenPicker
        ? await pickToolboxScreenColor()
        : eyeDropper
          ? (await new eyeDropper().open()).sRGBHex
          : null;
      if (sampledHex) {
        applyColor(parseColor(sampledHex));
        setNotice(t("local.colorPicker.applied"));
      }
    } catch (reason) {
      // Escape and browser cancellation are intentionally quiet: no color was changed.
      if (!isScreenPickCancellation(reason)) {
        setError(t("local.colorPicker.screenFailed"));
        setNotice("");
      }
    } finally {
      setPickingFromScreen(false);
    }
  };

  return (
    <div className="toolbox-tool-layout">
      <div className="toolbox-tool-layout__body color-picker">
        <section className="color-picker__workspace" style={hueStyle} aria-labelledby="color-picker-editor-title">
          <div className="color-picker__editor">
            <div className="color-picker__section-heading">
              <div>
                <span className="color-picker__eyebrow">{t("local.colorPicker.eyebrow")}</span>
                <h2 id="color-picker-editor-title">{t("local.colorPicker.title")}</h2>
              </div>
              <label className="color-picker__native-input">
                <span>{t("local.colorPicker.nativeInput")}</span>
                <input type="color" value={formats.hex.slice(0, 7)} onChange={(event) => applyColor(parseColor(event.target.value))} />
              </label>
            </div>

            <div
              className="color-picker__sv"
              style={hueStyle}
              role="slider"
              tabIndex={0}
              aria-label={t("local.colorPicker.saturationValue")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsv.v * 100)}
              aria-valuetext={`${Math.round(hsv.s * 100)}% / ${Math.round(hsv.v * 100)}%`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                updateSaturationValue(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSaturationValue(event);
              }}
              onKeyDown={handleSaturationValueKeyDown}
            >
              <span className="color-picker__sv-marker" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
            </div>

            <div className="color-picker__range-group">
              <label>
                <span>{t("local.colorPicker.hue")}</span>
                <input className="color-picker__hue" type="range" min="0" max="360" step="1" value={Math.round(hsv.h)} aria-label={t("local.colorPicker.hue")} onChange={(event) => updateFromHsv({ h: Number(event.target.value), s: hsv.s, v: hsv.v })} />
              </label>
              <label>
                <span>{t("local.colorPicker.alpha")} <output>{Math.round(color.a * 100)}%</output></span>
                <input className="color-picker__alpha" type="range" min="0" max="1" step="0.01" value={color.a} aria-label={t("local.colorPicker.alpha")} onChange={(event) => updateFromHsv(hsv, Number(event.target.value))} />
              </label>
            </div>

            <div className="color-picker__actions">
              {eyeDropper || nativeScreenPicker ? <button className="button button--secondary" disabled={pickingFromScreen} type="button" aria-busy={pickingFromScreen} onClick={() => void pickFromScreen()}><Pipette size={15} />{t("local.colorPicker.pickFromScreen")}</button> : <span className="color-picker__fallback"><Pipette size={14} />{t("local.colorPicker.screenUnavailable")}</span>}
            </div>
          </div>

          <aside className="color-picker__preview" aria-label={t("local.colorPicker.preview")}>
            <div className="color-picker__preview-swatch" style={{ "--color-picker-fill": formats.hex } as CSSProperties}>
              <span />
            </div>
            <div className="color-picker__preview-meta">
              <span>{t("local.colorPicker.currentColor")}</span>
              <strong>{formats.hex}</strong>
              <small>{Math.round(hsv.h)}° · {Math.round(hsv.s * 100)}% · {Math.round(hsv.v * 100)}%</small>
            </div>
          </aside>
        </section>

        <form className="color-picker__input" onSubmit={commitDraft}>
          <label htmlFor="color-picker-value">{t("local.colorPicker.inputLabel")}</label>
          <div>
            <input id="color-picker-value" className="toolbox-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("local.colorPicker.inputPlaceholder")} spellCheck={false} />
            <button className="button button--primary" type="submit"><Check size={15} />{t("local.colorPicker.apply")}</button>
          </div>
        </form>

        <section className="color-picker__formats" aria-labelledby="color-picker-formats-title">
          <div className="color-picker__section-heading color-picker__section-heading--compact">
            <div>
              <span className="color-picker__eyebrow">{t("local.colorPicker.outputEyebrow")}</span>
              <h2 id="color-picker-formats-title">{t("local.colorPicker.formats")}</h2>
            </div>
            <span className="color-picker__gamut" data-mapped={color.gamutMapped}>{color.gamutMapped ? t("local.colorPicker.gamutMapped") : t("local.colorPicker.srgb")}</span>
          </div>
          <div className="color-picker__format-grid">
            {FORMAT_FIELDS.map(({ key, label }) => (
              <article className="color-picker__format" key={key}>
                <div><span>{label}</span><code>{formats[key]}</code></div>
                <button className="icon-button" type="button" aria-label={t("local.colorPicker.copy", { format: label })} onClick={() => void copyFormat(key)}><Copy size={14} /></button>
              </article>
            ))}
          </div>
        </section>

        <section className="color-picker__contrast" aria-labelledby="color-picker-contrast-title">
          <div className="color-picker__section-heading color-picker__section-heading--compact">
            <div>
              <span className="color-picker__eyebrow">{t("local.colorPicker.accessibilityEyebrow")}</span>
              <h2 id="color-picker-contrast-title">{t("local.colorPicker.contrast")}</h2>
            </div>
          </div>
          <div className="color-picker__contrast-grid">
            <ContrastCard label={t("local.colorPicker.lightBackground")} ratio={lightContrast} color={formats.hex} background="#ffffff" passLabel={t("local.colorPicker.contrastPass")} failLabel={t("local.colorPicker.contrastFail")} />
            <ContrastCard label={t("local.colorPicker.darkBackground")} ratio={darkContrast} color={formats.hex} background="#000000" passLabel={t("local.colorPicker.contrastPass")} failLabel={t("local.colorPicker.contrastFail")} />
          </div>
        </section>

        {error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}
        {notice ? <p className="color-picker__notice" role="status">{notice}</p> : null}
      </div>
      <div className="toolbox-tool-layout__footer">
        <button className="button button--secondary" type="button" onClick={() => applyColor(DEFAULT_COLOR)}><RotateCcw size={14} />{t("local.colorPicker.reset")}</button>
        <span>{t("local.colorPicker.privacy")}</span>
      </div>
    </div>
  );
}

function ContrastCard({ label, ratio, color, background, passLabel, failLabel }: { label: string; ratio: number; color: string; background: string; passLabel: string; failLabel: string }) {
  const passes = ratio >= 4.5;
  return <article className="color-picker__contrast-card" style={{ backgroundColor: background, color }}><span>{label}</span><strong>{ratio.toFixed(2)}:1</strong><small data-pass={passes}>{passes ? passLabel : failLabel}</small></article>;
}

function detectEyeDropper(): EyeDropperLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { EyeDropper?: EyeDropperLike }).EyeDropper;
  return typeof candidate === "function" ? candidate : null;
}

function commandErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return typeof record.code === "string" ? record.code : null;
    }
  } catch {
    // Browser cancellation and ordinary errors do not carry command codes.
  }
  return null;
}

function isScreenPickCancellation(error: unknown): boolean {
  if (commandErrorCode(error) === "screen_color_cancelled") return true;
  return typeof error === "object"
    && error !== null
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
