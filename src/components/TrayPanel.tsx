import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BatteryMedium,
  CircleGauge,
  Database,
  Maximize2,
  MemoryStick,
  Pause,
  Play,
  Settings2,
  Sparkles,
  Thermometer,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import brandMark from "../assets/brand-mark.png";
import type { TraySummary } from "../traySummary";
import { formatBytes, formatPercent } from "../utils";

export function TrayPanel() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<TraySummary | null>(null);

  useEffect(() => {
    let disposed = false;
    let stopSummary: (() => void) | undefined;
    let stopFocus: (() => void) | undefined;
    void Promise.all([
      listen<TraySummary>("pulse:tray-summary", ({ payload }) => {
        if (!disposed) setSummary(payload);
      }).then((unlisten) => { stopSummary = unlisten; }),
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) void getCurrentWindow().hide();
      }).then((unlisten) => { stopFocus = unlisten; }),
    ]);
    return () => {
      disposed = true;
      stopSummary?.();
      stopFocus?.();
    };
  }, []);

  const openView = async (view: "overview" | "cleanup" | "settings") => {
    await invoke("show_main_window");
    await emitTo("main", "pulse:navigate", view);
  };
  const togglePaused = async () => {
    await emitTo("main", "pulse:set-paused", !summary?.paused);
  };

  return (
    <main className="tray-surface">
      <section className="tray-panel">
        <header className="tray-header">
          <span className="tray-logo"><img src={brandMark} alt="" /></span>
          <span className="tray-brand"><strong>Pulse</strong><small>{t("tray.localMonitor")}</small></span>
          <span className={`tray-health tray-health--${summary?.health ?? "loading"}`}>
            <i />{t(`tray.health.${summary?.health ?? "loading"}`)}
          </span>
        </header>

        <div className="tray-message">
          <strong>{t(`tray.status.${summary?.health ?? "loading"}.title`)}</strong>
          <span>
            {summary?.reason && summary.reason !== "none"
              ? t("tray.reason", { resource: t(`tray.resource.${summary.reason}`) })
              : t(`tray.status.${summary?.health ?? "loading"}.description`)}
          </span>
        </div>

        <div className="tray-metrics">
          <TrayMetric
            icon={<CircleGauge size={15} />}
            label="CPU"
            value={summary?.cpuPercent === null || summary?.cpuPercent === undefined ? "—" : formatPercent(summary.cpuPercent)}
            percent={summary?.cpuPercent ?? 0}
          />
          <TrayMetric
            icon={<MemoryStick size={15} />}
            label={t("tray.resource.memory")}
            value={summary ? formatPercent(summary.memoryPercent) : "—"}
            percent={summary?.memoryPercent ?? 0}
          />
          <TrayMetric
            icon={<Database size={15} />}
            label={t("tray.available")}
            value={summary?.storageAvailableBytes === null || summary?.storageAvailableBytes === undefined ? "—" : formatBytes(summary.storageAvailableBytes)}
            percent={summary?.storageUsedPercent ?? 0}
          />
        </div>

        <div className="tray-device-row">
          <span><Thermometer size={14} />{summary?.temperatureCelsius === null || summary?.temperatureCelsius === undefined ? t("common.unavailable") : `${Math.round(summary.temperatureCelsius)}°C`}</span>
          <span><BatteryMedium size={14} />{summary?.batteryPercent === null || summary?.batteryPercent === undefined ? t("common.unavailable") : formatPercent(summary.batteryPercent)}</span>
        </div>

        <div className="tray-actions">
          <button type="button" onClick={() => void openView("overview")}><Maximize2 size={16} /><span>{t("tray.open")}</span></button>
          <button type="button" onClick={() => void openView("cleanup")}><Sparkles size={16} /><span>{t("tray.cleanup")}</span></button>
          <button type="button" onClick={() => void togglePaused()}>
            {summary?.paused ? <Play size={16} /> : <Pause size={16} />}
            <span>{summary?.paused ? t("app.resume") : t("app.pause")}</span>
          </button>
          <button type="button" onClick={() => void openView("settings")}><Settings2 size={16} /><span>{t("app.settings")}</span></button>
        </div>
      </section>
    </main>
  );
}

function TrayMetric({
  icon,
  label,
  value,
  percent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  percent: number;
}) {
  return (
    <div className="tray-metric">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
      <i><span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></i>
    </div>
  );
}
