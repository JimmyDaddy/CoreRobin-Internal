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
  Orbit,
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
import { useTranslation } from "react-i18next";

import {
  buildDailyAttentionItems,
  buildDailyOrbitItems,
  dailyOverallLevel,
  type DailyAttentionItem,
  type DailyIntent,
} from "../dailyExperience";
import type { SmartDiagnosisResult } from "../diagnosis";
import { buildHistoryStories, type HistoryStory } from "../historyStories";
import type { ResourceAlertEvent } from "../resourceAlerts";
import type { SystemSnapshot } from "../types";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { Button } from "./Button";

interface DailyHomeProps {
  diagnosis: SmartDiagnosisResult;
  snapshot: SystemSnapshot;
  alertEvents: readonly ResourceAlertEvent[];
  onOpenIntent: (intent: DailyIntent) => void;
  onOpenSolve: () => void;
  onOpenRecords: () => void;
  onRefresh: () => void | Promise<void>;
}

const ORBIT_ICONS = {
  speed: Gauge,
  space: HardDrive,
  temperature: Flame,
  battery: BatteryCharging,
} as const;

export function DailyHome({
  diagnosis,
  snapshot,
  alertEvents,
  onOpenIntent,
  onOpenSolve,
  onOpenRecords,
  onRefresh,
}: DailyHomeProps) {
  const { t, i18n } = useTranslation();
  const [checking, setChecking] = useState(false);
  const level = dailyOverallLevel(diagnosis, snapshot);
  const orbitItems = useMemo(
    () => buildDailyOrbitItems(diagnosis, snapshot),
    [diagnosis, snapshot],
  );
  const attentionItems = useMemo(
    () => buildDailyAttentionItems(diagnosis, snapshot),
    [diagnosis, snapshot],
  );
  const suggestedPrimary = attentionItems[0] ?? null;
  const [primaryId, setPrimaryId] = useState<string | null>(
    () => suggestedPrimary?.id ?? null,
  );
  const primary = attentionItems.find(({ id }) => id === primaryId) ??
    suggestedPrimary;
  const latestStory = useMemo(
    () => buildHistoryStories(alertEvents)[0] ?? null,
    [alertEvents],
  );

  useEffect(() => {
    if (!primaryId && suggestedPrimary) {
      setPrimaryId(suggestedPrimary.id);
      return;
    }
    if (primaryId && !attentionItems.some(({ id }) => id === primaryId)) {
      setPrimaryId(suggestedPrimary?.id ?? null);
    }
  }, [attentionItems, primaryId, suggestedPrimary]);

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
          aria-label={t("daily.orbit.label")}
          onPointerMove={tiltDailyCompanion}
          onPointerLeave={resetDailyCompanionTilt}
        >
          <div className="daily-companion__scene">
            <div className="daily-companion__rig">
              <span className="daily-companion__halo daily-companion__halo--outer" aria-hidden="true" />
              <span className="daily-companion__halo daily-companion__halo--inner" aria-hidden="true" />
              <div className="daily-companion__core">
                <span>{checking ? <LoaderCircle size={29} /> : <Orbit size={29} />}</span>
                <small>{t("daily.companion.name")}</small>
              </div>
              {orbitItems.map((item, index) => {
                const Icon = ORBIT_ICONS[item.kind];
                return (
                  <span
                    className={`daily-companion__station daily-companion__station--${index + 1} is-${item.level}`}
                    key={item.kind}
                    aria-label={`${t(`daily.orbit.${item.kind}`)}: ${t(`daily.status.${item.level === "unavailable" ? "observing" : item.level}.short`)}`}
                  >
                    <Icon size={15} />
                    <i aria-hidden="true" />
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <div className="daily-companion-hero__message">
          <h1 id="daily-home-title">
            {t(checking ? "daily.home.checkingTitle" : `daily.status.${level}.title`, {
              count: attentionItems.length,
            })}
          </h1>
          <p>{t(checking ? "daily.home.checkingSummary" : `daily.status.${level}.summary`, {
            count: attentionItems.length,
          })}</p>
          <div className="daily-companion-hero__actions">
            <Button variant="primary" disabled={checking} onClick={() => void refresh()}>
              {checking ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}
              {t(checking ? "daily.home.checking" : "daily.home.checkNow")}
              {!checking ? <ArrowRight size={14} /> : null}
            </Button>
            <Button variant="secondary" onClick={onOpenSolve}>
              <Sparkles size={15} />{t("daily.home.haveProblem")}
            </Button>
          </div>
          <span className="daily-companion-hero__time"><Clock3 size={13} />{t("daily.home.checkedAt", {
            time: new Date(diagnosis.analyzedAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}</span>
        </div>
      </section>

      {primary ? (
        <section className={`daily-priority is-${primary.level}`} aria-labelledby="daily-priority-title">
          <span className="daily-priority__icon">
            <AttentionIcon item={primary} />
          </span>
          <div>
            <small>{t("daily.attention.priority")}</small>
            <h2 id="daily-priority-title">{attentionTitle(primary, t)}</h2>
            <p>{attentionDescription(primary, t)}</p>
          </div>
          <Button variant="secondary" onClick={() => onOpenIntent(primary.intent)}>
            {t("daily.attention.open")}<ArrowRight size={14} />
          </Button>
        </section>
      ) : null}

      <section className="daily-recent" aria-labelledby="daily-recent-title">
        <div className="daily-recent__heading">
          <span><History size={17} /></span>
          <div><small>{t("daily.story.kicker")}</small><h2 id="daily-recent-title">{t("daily.story.title")}</h2></div>
        </div>
        {latestStory ? <DailyStory story={latestStory} /> : (
          <div className="daily-recent__calm">
            <CheckCircle2 size={18} />
            <span><strong>{t("daily.story.emptyTitle")}</strong><small>{t("daily.story.emptyDescription")}</small></span>
          </div>
        )}
        <button type="button" onClick={onOpenRecords}>{t("daily.story.viewAll")}<ArrowRight size={13} /></button>
      </section>
    </section>
  );
}

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
  const application = item.kind === "application"
    ? item.application
    : item.kind === "diagnosis"
      ? item.finding.culprit
      : null;
  if (application) return <ApplicationAvatar application={application} />;
  if (item.kind === "battery") return <BatteryCharging size={20} />;
  if (item.kind === "temperature") return <Flame size={20} />;
  return <TriangleAlert size={20} />;
}

function attentionTitle(item: DailyAttentionItem, t: (key: string, options?: Record<string, unknown>) => string) {
  if (item.kind === "diagnosis") {
    return t(`diagnosis.findings.${item.finding.code}.title`, {
      resource: item.finding.resourceLabel ?? t("diagnosis.thisDisk"),
    });
  }
  if (item.kind === "application") return t("daily.attention.application.title", { name: item.application.name });
  if (item.kind === "sleep") return t("daily.attention.sleep.title", { name: item.name });
  return t(`daily.attention.${item.kind}.title`);
}

function attentionDescription(item: DailyAttentionItem, t: (key: string, options?: Record<string, unknown>) => string) {
  if (item.kind === "diagnosis") return t(`diagnosis.findings.${item.finding.code}.description`);
  if (item.kind === "application") return t(`daily.attention.application.${item.impact}`);
  if (item.kind === "sleep") return t("daily.attention.sleep.description");
  return t(`daily.attention.${item.kind}.description`);
}

function DailyStory({ story }: { story: HistoryStory }) {
  const { t, i18n } = useTranslation();
  const startedAt = new Date(story.startedAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const minutes = Math.max(1, Math.round(story.durationMs / 60_000));
  return (
    <article className={`daily-recent__story is-${story.status}`}>
      {story.status === "active" ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}
      <span>
        <small>{story.status === "active" ? t("daily.story.active") : t("daily.story.recovered")}</small>
        <strong>{t(`daily.story.${story.resource}.${story.status}`, { time: startedAt, minutes })}</strong>
        {story.culpritName ? <em>{t("daily.story.cause", { name: story.culpritName })}</em> : null}
      </span>
    </article>
  );
}
