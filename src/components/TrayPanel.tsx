import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  ArrowRight,
  BatteryMedium,
  CircleGauge,
  Clock3,
  Database,
  LogOut,
  Maximize2,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Sparkles,
  Thermometer,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import brandMark from "../assets/brand-mark.png";
import { createAsyncListenerRegistry } from "../asyncListener";
import { BrandWordmark } from "./BrandWordmark";
import { RobinIcon } from "./RobinIcon";
import { useSharedHealthState } from "../hooks/useSharedHealthState";
import {
  useSensorReadiness,
  type SensorReadiness,
} from "../hooks/useSensorReadiness";
import { getAuxiliaryLanguage } from "../i18nAuxiliary";
import { useAuxiliaryTranslation } from "../useAuxiliaryTranslation";
import { formatBytes, formatPercent } from "../utils";
import { loadAvailableUpdateVersion } from "../updateAvailability";

const desktopRuntime = typeof window !== "undefined"
  && "__TAURI_INTERNALS__" in window
  && getCurrentWindow().label === "tray";

export function TrayPanel() {
  const { t } = useAuxiliaryTranslation();
  const summary = useSharedHealthState();
  const language = getAuxiliaryLanguage();
  const [availableUpdateVersion, setAvailableUpdateVersion] = useState(
    loadAvailableUpdateVersion,
  );
  const sensorReadiness = useSensorReadiness({
    sampledAtMs: summary?.sampledAtMs ?? Date.now(),
    warmingUp: summary == null,
    temperatureCelsius: summary?.temperatureCelsius ?? null,
    batteryPresent: summary?.batteryPercent != null,
    batteryPercent: summary?.batteryPercent ?? null,
    batteryDetailsAvailable: summary?.batteryHealthPercent != null
      || summary?.batteryCycleCount != null,
  });

  useEffect(() => {
    if (!desktopRuntime) return;
    const listeners = createAsyncListenerRegistry();
    listeners.register(
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (listeners.disposed) return;
        if (focused) setAvailableUpdateVersion(loadAvailableUpdateVersion());
        else void getCurrentWindow().hide();
      }),
    );
    return () => listeners.dispose();
  }, []);

  const openView = async (view: "overview" | "cleanup" | "settings") => {
    await invoke("show_main_window");
    if (view === "overview" && summary?.primaryIncident) {
      await emitTo("main", "core-robin:open-daily", {
        view,
        occurrenceId: summary.primaryIncident.occurrenceId,
      });
      return;
    }
    await emitTo("main", "core-robin:navigate", view);
  };
  const togglePaused = async () => {
    await emitTo("main", "core-robin:set-paused", !summary?.paused);
  };
  const toggleCompanion = async () => {
    await invoke("toggle_companion_window");
    await getCurrentWindow().hide();
  };
  const quitApplication = async () => {
    await invoke("quit_application");
  };
  const lastUpdated = summary
    ? new Date(summary.sampledAtMs).toLocaleTimeString(getAuxiliaryLanguage(), {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <main className="tray-surface">
      <section className="tray-panel">
        <header className="tray-header">
          <span className="tray-logo"><img src={brandMark} alt="" /></span>
          <span className="tray-brand"><BrandWordmark /><small>{t("tray:localMonitor")}</small></span>
          <span className={`tray-health tray-health--${summary?.health ?? "loading"}`}>
            <i />{t(`tray:health.${summary?.health ?? "loading"}`)}
          </span>
        </header>

        <button
          className="tray-message"
          type="button"
          aria-label={t("tray:open")}
          onClick={() => void openView("overview")}
        >
          <span>
            <strong>
              {summary && summary.activeCount > 0 &&
                (summary.health === "attention" || summary.health === "urgent")
                ? t(`tray:incidentTitle.${summary.health}`, { count: summary.activeCount })
                : t(`tray:status.${summary?.health ?? "loading"}.title`)}
            </strong>
            <small>
              {summary?.primaryIncident?.phase === "recovering"
                ? t("tray:recovering")
                : summary?.reason && summary.reason !== "none"
                ? t("tray:reason", { resource: t(`tray:resource.${summary.reason}`) })
                : t(`tray:status.${summary?.health ?? "loading"}.description`)}
            </small>
          </span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>

        <div className="tray-metrics">
          <TrayMetric
            icon={<CircleGauge size={15} />}
            label="CPU"
            value={summary?.cpuPercent === null || summary?.cpuPercent === undefined ? "—" : formatPercent(summary.cpuPercent)}
            percent={summary?.cpuPercent ?? 0}
          />
          <TrayMetric
            icon={<MemoryStick size={15} />}
            label={t("tray:resource.memory")}
            value={summary ? formatPercent(summary.memoryPercent) : "—"}
            percent={summary?.memoryPercent ?? 0}
          />
          <TrayMetric
            icon={<Database size={15} />}
            label={t("tray:available")}
            value={summary?.storageAvailableBytes === null || summary?.storageAvailableBytes === undefined ? "—" : formatBytes(summary.storageAvailableBytes)}
            percent={summary?.storageUsedPercent ?? 0}
          />
        </div>

        <div className="tray-device-row">
          <span>
            <Thermometer size={15} />
            <span>
              <small>{t("tray:resource.temperature")}</small>
              <strong>{summary?.temperatureCelsius == null
                ? t(`wellbeing:readiness.short.${sensorReadiness.temperature.status}`)
                : `${Math.round(summary.temperatureCelsius)}°C`}</strong>
              <TrayReadiness kind="temperature" readiness={sensorReadiness.temperature} />
            </span>
          </span>
          <span>
            <BatteryMedium size={15} />
            <span>
              <small>{t("tray:resource.battery")}</small>
              <strong>{summary?.batteryPercent == null
                ? t(`wellbeing:readiness.short.${sensorReadiness.battery.status}`)
                : formatPercent(summary.batteryPercent)}</strong>
              {summary?.batteryPercent !== null && summary?.batteryPercent !== undefined ? <em>{t(`wellbeing:battery.state.${summary.batteryState}`)}</em> : null}
              <em className="tray-battery-detail">
                <i>{t("wellbeing:battery.healthLabel")}</i>
                <b>{summary?.batteryHealthPercent === null || summary?.batteryHealthPercent === undefined
                  ? t("common:unavailable")
                  : formatPercent(summary.batteryHealthPercent)}</b>
              </em>
              <em className="tray-battery-detail">
                <i>{t("wellbeing:battery.cycleCountLabel")}</i>
                <b>{summary?.batteryCycleCount === null || summary?.batteryCycleCount === undefined
                  ? t("common:unavailable")
                  : summary.batteryCycleCount.toLocaleString(language)}</b>
              </em>
              <TrayReadiness
                kind={sensorReadiness.battery.status === "available" ? "batteryDetails" : "battery"}
                readiness={sensorReadiness.battery.status === "available"
                  ? sensorReadiness.batteryDetails
                  : sensorReadiness.battery}
              />
            </span>
          </span>
        </div>

        <div className="tray-context">
          <span><Clock3 size={13} />{lastUpdated ? t("tray:updatedAt", { time: lastUpdated }) : t("tray:health.loading")}</span>
          <span><Activity size={13} />{summary?.paused ? t("app:paused") : t(`tray:dataMode.${summary?.dataMode ?? "background"}`)}</span>
        </div>

        {availableUpdateVersion ? (
          <button
            className="tray-update"
            type="button"
            onClick={() => void openView("settings")}
          >
            <RefreshCw size={14} />
            <span>{t("tray:updateAvailable", {
              version: availableUpdateVersion,
            })}</span>
            <ArrowRight size={14} />
          </button>
        ) : null}

        <div className="tray-actions">
          <div className="tray-actions__primary">
            <button type="button" onClick={() => void openView("overview")}><Maximize2 size={16} /><span>{t("tray:open")}</span></button>
            <button type="button" onClick={() => void toggleCompanion()}><RobinIcon size={18} /><span>{t("tray:companion")}</span></button>
            <button type="button" onClick={() => void openView("cleanup")}><Sparkles size={16} /><span>{t("tray:cleanup")}</span></button>
          </div>
          <div className="tray-actions__utility">
            <button type="button" onClick={() => void togglePaused()}>
              {summary?.paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{summary?.paused ? t("app:resume") : t("app:pause")}</span>
            </button>
            <button type="button" onClick={() => void openView("settings")}><Settings2 size={14} /><span>{t("app:settings")}</span></button>
            <button className="tray-action--quit" type="button" onClick={() => void quitApplication()}><LogOut size={14} /><span>{t("tray:quit")}</span></button>
          </div>
        </div>
      </section>
    </main>
  );
}

function TrayReadiness({
  kind,
  readiness,
}: {
  kind: "temperature" | "battery" | "batteryDetails";
  readiness: SensorReadiness;
}) {
  const { t } = useAuxiliaryTranslation();
  if (readiness.status === "available") return null;
  return (
    <details className="tray-sensor-readiness">
      <summary>{t("wellbeing:readiness.why")}</summary>
      <p>{t(`wellbeing:readiness.${kind}.${readiness.status}`)}</p>
      {readiness.lastSuccessfulAtMs !== null ? (
        <small>{t("wellbeing:readiness.lastSuccessful", {
          time: new Date(readiness.lastSuccessfulAtMs).toLocaleTimeString(
            getAuxiliaryLanguage(),
            { hour: "2-digit", minute: "2-digit" },
          ),
        })}</small>
      ) : null}
    </details>
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
