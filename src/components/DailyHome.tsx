import {
  ArrowRight,
  BatteryCharging,
  CheckCircle2,
  Clock3,
  Flame,
  Gauge,
  HardDrive,
  History,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  type DailyAttentionItem,
  type DailyStatusKind,
} from "../dailyExperience";
import {
  buildStableDailyStatusItems,
  dailyIncidentDisplayLevel,
  dailyIncidentLevel,
  type DailyIncident,
} from "../dailyIncidents";
import type { SmartDiagnosisResult } from "../diagnosis";
import { buildHistoryStories, type HistoryStory } from "../historyStories";
import type { ResourceAlertEvent } from "../resourceAlerts";
import type { SystemSnapshot } from "../types";
import { formatBytes } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { AnimatedRobin } from "./AnimatedRobin";
import { Button } from "./Button";

interface DailyHomeProps {
  diagnosis: SmartDiagnosisResult;
  snapshot: SystemSnapshot;
  incidents: readonly DailyIncident[];
  alertEvents: readonly ResourceAlertEvent[];
  onOpenIncident: (incident: DailyIncident) => void;
  onOpenCheck: (kind: DailyStatusKind) => void;
  onOpenSolve: () => void;
  onOpenRecords: () => void;
  onRefresh: () => void | Promise<void>;
}

const STATUS_ICONS = {
  speed: Gauge,
  space: HardDrive,
  temperature: Flame,
  battery: BatteryCharging,
} as const;

type DailyCheckKind = keyof typeof STATUS_ICONS;

export function DailyHome({
  diagnosis,
  snapshot,
  incidents,
  alertEvents,
  onOpenIncident,
  onOpenCheck,
  onOpenSolve,
  onOpenRecords,
  onRefresh,
}: DailyHomeProps) {
  const { t, i18n } = useAppTranslation();
  const [checking, setChecking] = useState(false);
  const [focusedCheck, setFocusedCheck] = useState<DailyCheckKind | null>(null);
  const level = dailyIncidentLevel(incidents, diagnosis.baselineReady);
  const statusItems = useMemo(
    () => buildStableDailyStatusItems(incidents, diagnosis, snapshot),
    [diagnosis, incidents, snapshot],
  );
  const suggestedPrimary = incidents[0] ?? null;
  const [primaryId, setPrimaryId] = useState<string | null>(
    () => suggestedPrimary?.id ?? null,
  );
  const primary = incidents.find(({ id }) => id === primaryId) ??
    suggestedPrimary;
  const latestStory = useMemo(
    () => buildHistoryStories(alertEvents)[0] ?? null,
    [alertEvents],
  );
  const primaryVolume = useMemo(() => {
    const volumes = snapshot.disk.volumes.filter(({ totalBytes }) => totalBytes > 0);
    return volumes.find(({ mountPoint }) => mountPoint === "/") ??
      [...volumes].sort((left, right) => right.totalBytes - left.totalBytes)[0] ??
      null;
  }, [snapshot.disk.volumes]);
  const primaryVolumeUsed = primaryVolume
    ? Math.max(0, primaryVolume.totalBytes - primaryVolume.availableBytes)
    : 0;
  const primaryVolumeUsage = primaryVolume
    ? Math.min(100, Math.max(0, (primaryVolumeUsed / primaryVolume.totalBytes) * 100))
    : 0;

  useEffect(() => {
    if (!primaryId && suggestedPrimary) {
      setPrimaryId(suggestedPrimary.id);
      return;
    }
    if (primaryId && !incidents.some(({ id }) => id === primaryId)) {
      setPrimaryId(suggestedPrimary?.id ?? null);
    }
  }, [incidents, primaryId, suggestedPrimary]);

  const refresh = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="daily-home" aria-labelledby="daily-home-title">
      <section className={`daily-companion-hero is-${level}${checking ? " is-checking" : ""}`}>
        <div
          className="daily-companion"
          aria-label={t("daily:checks.label")}
          onPointerMove={tiltDailyCompanion}
          onPointerLeave={(event) => {
            setFocusedCheck(null);
            resetDailyCompanionTilt(event);
          }}
        >
          <div className="daily-companion__scene">
            <div
              className="daily-companion__rig"
              data-focus={focusedCheck ?? undefined}
              data-level={checking ? "checking" : level}
            >
              <div className="daily-companion__core">
                <AnimatedRobin
                  active={checking}
                  mood={level}
                  size={160}
                />
                <span className="daily-companion__console" aria-hidden="true">
                  <i /><i /><i />
                </span>
                <span
                  className={`daily-companion__callout${focusedCheck ? " is-visible" : ""}`}
                  aria-hidden="true"
                >
                  {focusedCheck ? t(`daily:checks.${focusedCheck}`) : null}
                </span>
              </div>
              <span className="daily-companion__interaction" aria-hidden="true"><i /></span>
              <div className="daily-companion__checks">
                {statusItems.map((item) => {
                  const Icon = STATUS_ICONS[item.kind];
                  const displayLevel = item.level === "unavailable" ? "observing" : item.level;
                  return (
                    <button
                      type="button"
                      className={`daily-companion__station is-${item.level}`}
                      key={item.kind}
                      data-active={focusedCheck === item.kind ? "true" : undefined}
                      aria-label={`${t(`daily:checks.${item.kind}`)}: ${t(`daily:status.${displayLevel}.short`)}`}
                      onClick={() => onOpenCheck(item.kind)}
                      onFocus={() => setFocusedCheck(item.kind)}
                      onBlur={() => setFocusedCheck((current) => current === item.kind ? null : current)}
                      onPointerEnter={() => setFocusedCheck(item.kind)}
                      onPointerLeave={() => setFocusedCheck((current) => current === item.kind ? null : current)}
                    >
                      <span className="daily-companion__station-icon">
                        <Icon size={18} />
                      </span>
                      <span className="daily-companion__station-label">
                        <small>{t(`daily:checks.${item.kind}`)}</small>
                        <ArrowRight size={11} aria-hidden="true" />
                      </span>
                      <i aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="daily-companion-hero__message">
          <h1 id="daily-home-title">
            {t(checking ? "daily:home.checkingTitle" : `daily:status.${level}.title`, {
              count: incidents.length,
            })}
          </h1>
          <p>{t(checking ? "daily:home.checkingSummary" : `daily:status.${level}.summary`, {
            count: incidents.length,
          })}</p>
          <div className="daily-companion-hero__actions">
            <Button variant="primary" disabled={checking} onClick={() => void refresh()}>
              {checking ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}
              {t(checking ? "daily:home.checking" : "daily:home.checkNow")}
              {!checking ? <ArrowRight size={14} /> : null}
            </Button>
            <Button variant="secondary" onClick={onOpenSolve}>
              <Sparkles size={15} />{t("daily:home.haveProblem")}
            </Button>
          </div>
          <span className="daily-companion-hero__time"><Clock3 size={13} />{t("daily:home.checkedAt", {
            time: new Date(diagnosis.analyzedAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}</span>
        </div>
      </section>

      {primaryVolume ? (
        <button
          className="daily-storage-glance"
          type="button"
          aria-label={t("daily:home.storage.open")}
          onClick={() => onOpenCheck("space")}
        >
          <span className="daily-storage-glance__icon"><HardDrive size={18} /></span>
          <span className="daily-storage-glance__copy">
            <small>{t("daily:home.storage.kicker")}</small>
            <strong>{t("daily:home.storage.summary", {
              used: formatBytes(primaryVolumeUsed),
              total: formatBytes(primaryVolume.totalBytes),
            })}</strong>
          </span>
          <span className="daily-storage-glance__meter">
            <i style={{ width: `${primaryVolumeUsage}%` }} />
          </span>
          <span className="daily-storage-glance__available">
            <strong>{formatBytes(primaryVolume.availableBytes)}</strong>
            <small>{t("daily:home.storage.available")}</small>
          </span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      ) : null}

      {primary ? (
        <section className={`daily-priority is-${dailyIncidentDisplayLevel(primary)}`} aria-labelledby="daily-priority-title">
          <span className="daily-priority__icon">
            <AttentionIcon item={primary.item} />
          </span>
          <div>
            <small>{t(primary.phase === "recovering"
              ? "daily:attention.recovering"
              : "daily:attention.priority")}</small>
            <h2 id="daily-priority-title">{attentionTitle(primary.item, t)}</h2>
            <p>{primary.phase === "recovering"
              ? t("daily:incident.recoveringDescription")
              : attentionDescription(primary.item, t)}</p>
          </div>
          <Button variant="secondary" onClick={() => onOpenIncident(primary)}>
            {t("daily:attention.open")}<ArrowRight size={14} />
          </Button>
        </section>
      ) : null}

      <section className="daily-recent" aria-labelledby="daily-recent-title">
        <div className="daily-recent__heading">
          <span><History size={17} /></span>
          <div><small>{t("daily:story.kicker")}</small><h2 id="daily-recent-title">{t("daily:story.title")}</h2></div>
        </div>
        {latestStory ? <DailyStory story={latestStory} /> : (
          <div className="daily-recent__calm">
            <CheckCircle2 size={18} />
            <span><strong>{t("daily:story.emptyTitle")}</strong><small>{t("daily:story.emptyDescription")}</small></span>
          </div>
        )}
        <button type="button" onClick={onOpenRecords}>{t("daily:story.viewAll")}<ArrowRight size={13} /></button>
      </section>
    </section>
  );
}

export default DailyHome;

function tiltDailyCompanion(event: ReactPointerEvent<HTMLDivElement>) {
  if (
    event.pointerType !== "mouse" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.reduceMotion === "true"
  ) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const horizontal = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
  const vertical = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
  event.currentTarget.style.setProperty("--companion-tilt-x", `${(-vertical * 4).toFixed(2)}deg`);
  event.currentTarget.style.setProperty("--companion-tilt-y", `${(horizontal * 5).toFixed(2)}deg`);
  event.currentTarget.style.setProperty("--companion-light-x", `${(50 + horizontal * 18).toFixed(1)}%`);
  event.currentTarget.style.setProperty("--companion-light-y", `${(42 + vertical * 14).toFixed(1)}%`);
}

function resetDailyCompanionTilt(event: ReactPointerEvent<HTMLDivElement>) {
  event.currentTarget.style.removeProperty("--companion-tilt-x");
  event.currentTarget.style.removeProperty("--companion-tilt-y");
  event.currentTarget.style.removeProperty("--companion-light-x");
  event.currentTarget.style.removeProperty("--companion-light-y");
}

function AttentionIcon({ item }: { item: DailyAttentionItem }) {
  const application = item.kind === "diagnosis" ? item.finding.culprit : null;
  if (application) {
    return <ApplicationAvatar name={application.name} source={{ process: application.iconProcess }} />;
  }
  if (item.kind === "battery") return <BatteryCharging size={20} />;
  if (item.kind === "temperature") return <Flame size={20} />;
  return <TriangleAlert size={20} />;
}

function attentionTitle(item: DailyAttentionItem, t: AppTFunction) {
  if (item.kind === "diagnosis") {
    return t(`diagnosis:findings.${item.finding.code}.title`, {
      resource: item.finding.resourceLabel ?? t("diagnosis:thisDisk"),
    });
  }
  if (item.kind === "sleep") return t("daily:attention.sleep.title", { name: item.name });
  return t(`daily:attention.${item.kind}.title`);
}

function attentionDescription(item: DailyAttentionItem, t: AppTFunction) {
  if (item.kind === "diagnosis") return t(`diagnosis:findings.${item.finding.code}.description`);
  if (item.kind === "sleep") return t("daily:attention.sleep.description");
  return t(`daily:attention.${item.kind}.description`);
}

function DailyStory({ story }: { story: HistoryStory }) {
  const { t, i18n } = useAppTranslation();
  const startedAt = new Date(story.startedAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const minutes = Math.max(1, Math.round(story.durationMs / 60_000));
  return (
    <article className={`daily-recent__story is-${story.status}`}>
      {story.status === "active" ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}
      <span>
        <small>{story.status === "active" ? t("daily:story.active") : t("daily:story.recovered")}</small>
        <strong>{t(`daily:story.${story.resource}.${story.status}`, { time: startedAt, minutes })}</strong>
        {story.culpritName ? <em>{t("daily:story.cause", { name: story.culpritName })}</em> : null}
      </span>
    </article>
  );
}
