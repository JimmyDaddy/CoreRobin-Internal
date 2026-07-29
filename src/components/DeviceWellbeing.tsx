import {
  ArrowRight,
  BatteryLow,
  CheckCircle2,
  MoonStar,
  ThermometerSun,
  TriangleAlert,
} from "lucide-react";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  batteryWellbeingLevel,
  sleepWellbeingLevel,
  summarizeSleepBlockers,
  temperatureWellbeingLevel,
  type DeviceWellbeingLevel,
} from "../deviceWellbeing";
import type { ApplicationImpact } from "../diagnosis";
import type { SensorsSnapshot } from "../types";
import { useSensorReadiness, type SensorReadiness } from "../hooks/useSensorReadiness";
import { formatPercent } from "../utils";
import "./DeviceWellbeing.css";

export function DeviceWellbeing({
  sensors,
  warmingUp = false,
  applications = [],
  onInspectSleepBlocker,
}: {
  sensors: SensorsSnapshot;
  warmingUp?: boolean;
  applications?: readonly ApplicationImpact[];
  onInspectSleepBlocker?: (identity: string) => void;
}) {
  const { t, i18n } = useAppTranslation();
  const temperatureLevel = temperatureWellbeingLevel(sensors.temperature);
  const batteryLevel = batteryWellbeingLevel(sensors.battery);
  const sleepLevel = sleepWellbeingLevel(sensors.sleep, applications);
  const sleepBlockers = summarizeSleepBlockers(sensors.sleep, applications);
  const readiness = useSensorReadiness({
    sampledAtMs: sensors.sampledAtMs,
    warmingUp,
    temperatureCelsius: sensors.temperature.celsius,
    batteryPresent: sensors.battery.present,
    batteryPercent: sensors.battery.chargePercent,
    batteryDetailsAvailable: sensors.battery.healthPercent !== null || sensors.battery.cycleCount !== null,
  });
  const userSleepBlockers = sleepBlockers.filter(({ systemComponent }) => !systemComponent);
  return (
    <section className="panel device-wellbeing" aria-labelledby="device-wellbeing-title">
      <header>
        <div>
          <span className="eyebrow">{t("wellbeing:eyebrow")}</span>
          <h2 id="device-wellbeing-title">{t("wellbeing:title")}</h2>
          <p>{t("wellbeing:description")}</p>
        </div>
        <span className={`is-${overallLevel(temperatureLevel, batteryLevel, sleepLevel)}`}>
          {t(`wellbeing:overall.${overallLevel(temperatureLevel, batteryLevel, sleepLevel)}`)}
        </span>
      </header>
      <div className="device-wellbeing__grid">
        <article className={`is-${temperatureLevel}`}>
          <WellbeingIcon level={temperatureLevel} fallback="temperature" />
          <div>
            <small>{t("wellbeing:temperature.label")}</small>
            <strong>{sensors.temperature.celsius === null
              ? t(`wellbeing:readiness.short.${readiness.temperature.status}`)
              : `${sensors.temperature.celsius.toFixed(0)} °C`}</strong>
            <p>{t(`wellbeing:temperature.${temperatureLevel}`)}</p>
            <ReadinessHint kind="temperature" readiness={readiness.temperature} />
          </div>
        </article>
        <article className={`is-${batteryLevel}`}>
          <WellbeingIcon level={batteryLevel} fallback="battery" />
          <div>
            <small>{t("wellbeing:battery.label")}</small>
            <strong>{sensors.battery.present && sensors.battery.chargePercent !== null
              ? `${sensors.battery.chargePercent.toFixed(0)}%`
              : t(`wellbeing:readiness.short.${readiness.battery.status}`)}</strong>
            <p>{batteryDescription(sensors, batteryLevel, t)}</p>
            <dl className="device-wellbeing__battery-facts">
              <div>
                <dt>{t("wellbeing:battery.healthLabel")}</dt>
                <dd>{sensors.battery.healthPercent === null
                  ? t("common:unavailable")
                  : formatPercent(sensors.battery.healthPercent)}</dd>
              </div>
              <div>
                <dt>{t("wellbeing:battery.cycleCountLabel")}</dt>
                <dd>{sensors.battery.cycleCount === null
                  ? t("common:unavailable")
                  : sensors.battery.cycleCount.toLocaleString(i18n.resolvedLanguage)}</dd>
              </div>
            </dl>
            {readiness.battery.status !== "available"
              ? <ReadinessHint kind="battery" readiness={readiness.battery} />
              : readiness.batteryDetails.status !== "available"
                ? <ReadinessHint kind="batteryDetails" readiness={readiness.batteryDetails} />
                : null}
          </div>
        </article>
        <article className={`is-${sleepLevel}`}>
          <WellbeingIcon level={sleepLevel} fallback="sleep" />
          <div>
            <small>{t("wellbeing:sleep.label")}</small>
            <strong>{sleepValue(
              sensors,
              userSleepBlockers.length,
              sleepBlockers.length,
              t,
            )}</strong>
            <p>{sleepDescription(
              sensors,
              userSleepBlockers,
              sleepBlockers.length,
              t,
            )}</p>
            {userSleepBlockers.length > 0 ? (
              <div className="device-wellbeing__sleep-actions">
                {userSleepBlockers.map((blocker) => (
                  <button
                    key={`${blocker.name}:${blocker.processIdentity ?? "unknown"}`}
                    type="button"
                    disabled={!blocker.processIdentity || !onInspectSleepBlocker}
                    onClick={() => {
                      if (blocker.processIdentity) onInspectSleepBlocker?.(blocker.processIdentity);
                    }}
                  >
                    <span>
                      <strong>{blocker.name}</strong>
                      <small>{sleepDurationLabel(blocker.durationSeconds, t)}</small>
                    </span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  );
}

export default DeviceWellbeing;

function ReadinessHint({
  kind,
  readiness,
}: {
  kind: "temperature" | "battery" | "batteryDetails";
  readiness: SensorReadiness;
}) {
  const { t, i18n } = useAppTranslation();
  if (readiness.status === "available") return null;
  return (
    <details className="sensor-readiness">
      <summary>{t("wellbeing:readiness.why")}</summary>
      <p>{t(`wellbeing:readiness.${kind}.${readiness.status}`)}</p>
      {readiness.lastSuccessfulAtMs !== null ? (
        <small>{t("wellbeing:readiness.lastSuccessful", {
          time: new Date(readiness.lastSuccessfulAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        })}</small>
      ) : null}
    </details>
  );
}

function WellbeingIcon({
  level,
  fallback,
}: {
  level: DeviceWellbeingLevel;
  fallback: "temperature" | "battery" | "sleep";
}) {
  if (level === "urgent" || level === "attention") return <span><TriangleAlert size={17} /></span>;
  if (level === "normal") return <span><CheckCircle2 size={17} /></span>;
  return (
    <span>{fallback === "temperature"
      ? <ThermometerSun size={17} />
      : fallback === "battery"
        ? <BatteryLow size={17} />
        : <MoonStar size={17} />}</span>
  );
}

function batteryDescription(
  sensors: SensorsSnapshot,
  level: DeviceWellbeingLevel,
  t: AppTFunction,
) {
  const { battery } = sensors;
  if (!battery.present) return t("wellbeing:battery.unavailable");
  const state = t(`wellbeing:battery.state.${battery.state}`);
  const remaining = battery.timeRemainingMinutes === null
    ? null
    : t("wellbeing:battery.remaining", {
        hours: Math.floor(battery.timeRemainingMinutes / 60),
        minutes: battery.timeRemainingMinutes % 60,
      });
  return `${t(`wellbeing:battery.${level}`)} · ${state}${remaining ? ` · ${remaining}` : ""}`;
}

function sleepValue(
  sensors: SensorsSnapshot,
  userBlockerCount: number,
  blockerCount: number,
  t: AppTFunction,
) {
  if (!sensors.sleep.available) return t("wellbeing:sleep.unavailableValue");
  if (userBlockerCount > 0) {
    return t("wellbeing:sleep.blockedValue", { count: userBlockerCount });
  }
  if (blockerCount > 0) return t("wellbeing:sleep.systemValue");
  return t("wellbeing:sleep.clearValue");
}

function sleepDescription(
  sensors: SensorsSnapshot,
  userBlockers: ReturnType<typeof summarizeSleepBlockers>,
  blockerCount: number,
  t: AppTFunction,
) {
  if (!sensors.sleep.available) return t("wellbeing:sleep.unavailable");
  const primary = userBlockers[0];
  if (primary) {
    return t("wellbeing:sleep.blocked", {
      name: primary.name,
      duration: sleepDurationLabel(primary.durationSeconds, t),
      more: userBlockers.length > 1
        ? t("wellbeing:sleep.more", { count: userBlockers.length - 1 })
        : "",
    });
  }
  if (blockerCount > 0) return t("wellbeing:sleep.system");
  return t("wellbeing:sleep.clear");
}

function sleepDurationLabel(
  durationSeconds: number | null,
  t: AppTFunction,
) {
  if (durationSeconds === null) return t("wellbeing:sleep.duration.unknown");
  if (durationSeconds < 60) return t("wellbeing:sleep.duration.lessThanMinute");
  if (durationSeconds < 3_600) {
    return t("wellbeing:sleep.duration.minutes", {
      count: Math.max(1, Math.round(durationSeconds / 60)),
    });
  }
  return t("wellbeing:sleep.duration.hours", {
    count: Math.max(1, Math.round(durationSeconds / 3_600)),
  });
}

function overallLevel(
  ...levels: DeviceWellbeingLevel[]
): DeviceWellbeingLevel {
  if (levels.includes("urgent")) return "urgent";
  if (levels.includes("attention")) return "attention";
  if (levels.includes("normal")) return "normal";
  return "unavailable";
}
