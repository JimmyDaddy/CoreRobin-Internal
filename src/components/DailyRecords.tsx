import {
  CheckCircle2,
  Clock3,
  History,
  TriangleAlert,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  buildHistoryStories,
  groupHistoryStoriesByDay,
  type HistoryStory,
} from "../historyStories";
import type { ResourceAlertEvent } from "../resourceAlerts";
import type { UserActionKind, UserActionRecord } from "../userActionHistory";
import { UserActionTimeline } from "./UserActionTimeline";

interface DailyRecordsProps {
  alertEvents: readonly ResourceAlertEvent[];
  actionRecords: readonly UserActionRecord[];
  storedActionCount: number;
  onOpenAction: (kind: UserActionKind) => void;
  onClearSavedActions: () => void;
}

export function DailyRecords({
  alertEvents,
  actionRecords,
  storedActionCount,
  onOpenAction,
  onClearSavedActions,
}: DailyRecordsProps) {
  const { t } = useAppTranslation();
  const [showAll, setShowAll] = useState(false);
  const stories = useMemo(() => buildHistoryStories(alertEvents), [alertEvents]);
  const visibleStories = showAll ? stories : stories.slice(0, 12);
  const groups = useMemo(
    () => groupHistoryStoriesByDay(visibleStories),
    [visibleStories],
  );
  return (
    <section className="daily-records" aria-labelledby="daily-records-title">
      <header className="daily-records__hero">
        <span><History size={23} /></span>
        <div><small>{t("daily:records.kicker")}</small><h1 id="daily-records-title">{t("daily:records.title")}</h1><p>{t("daily:records.description")}</p></div>
      </header>

      {actionRecords.length > 0 ? (
        <UserActionTimeline
          records={actionRecords}
          storedCount={storedActionCount}
          compact
          onOpenAction={onOpenAction}
          onClearSaved={onClearSavedActions}
        />
      ) : null}

      {stories.length > 0 ? (
        <div className="daily-records__groups">
          {groups.map((group) => (
            <section className="daily-records__group" key={group.key}>
              <header><strong>{t(`daily:records.groups.${group.key}`)}</strong><small>{group.stories.length}</small></header>
              <div className="daily-records__timeline">
                {group.stories.map((story) => <RecordRow story={story} key={story.id} />)}
              </div>
            </section>
          ))}
        </div>
      ) : actionRecords.length === 0 ? (
        <div className="daily-records__empty">
          <CheckCircle2 size={24} />
          <div><strong>{t("daily:records.emptyTitle")}</strong><span>{t("daily:records.emptyDescription")}</span></div>
        </div>
      ) : null}

      {stories.length > 12 ? (
        <button className="daily-records__more" type="button" onClick={() => setShowAll((current) => !current)}>
          {t(showAll ? "daily:records.showLess" : "daily:records.showMore", { count: stories.length })}
          {showAll ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : null}
    </section>
  );
}

function RecordRow({ story }: { story: HistoryStory }) {
  const { t, i18n } = useAppTranslation();
  const startedAt = new Date(story.startedAtMs);
  const minutes = Math.max(1, Math.round(story.durationMs / 60_000));
  return (
    <article className={`daily-record-row is-${story.status}`}>
      <span className="daily-record-row__marker">{story.status === "active" ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}</span>
      <time dateTime={startedAt.toISOString()}>
        <strong>{startedAt.toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" })}</strong>
        <small>{startedAt.toLocaleDateString(i18n.resolvedLanguage, { month: "short", day: "numeric" })}</small>
      </time>
      <div>
        <small>{story.status === "active" ? t("daily:story.active") : t("daily:story.recovered")}</small>
        <strong>{t(`daily:story.${story.resource}.${story.status}`, {
          time: startedAt.toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" }),
          minutes,
        })}</strong>
        {story.culpritName ? <span>{t("daily:story.cause", { name: story.culpritName })}</span> : null}
      </div>
      <em><Clock3 size={12} />{t("daily:records.duration", { minutes })}</em>
    </article>
  );
}
