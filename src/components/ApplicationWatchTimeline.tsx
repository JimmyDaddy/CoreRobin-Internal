import {
  BellRing,
  CheckCircle2,
  Cpu,
  HardDrive,
  MemoryStick,
  TriangleAlert,
} from "lucide-react";

import type { ApplicationWatchHistoryEvent } from "../applicationWatchHistory";
import { useAppTranslation } from "../i18n/useAppTranslation";

export function ApplicationWatchTimeline({
  events,
  compact = false,
}: {
  events: readonly ApplicationWatchHistoryEvent[];
  compact?: boolean;
}) {
  const { t, i18n } = useAppTranslation();
  const visibleEvents = [...events].reverse().slice(0, compact ? 8 : 100);
  if (visibleEvents.length === 0) return null;
  return (
    <section
      className={`application-watch-timeline${compact ? " is-compact" : ""}`}
      aria-labelledby="application-watch-history-title"
    >
      <header>
        <span><BellRing size={16} /></span>
        <div>
          <strong id="application-watch-history-title">
            {t("history:watchRules.title")}
          </strong>
          <small>{t("history:watchRules.description")}</small>
        </div>
      </header>
      <div>
        {visibleEvents.map((event) => {
          const Icon = event.metric === "cpu"
            ? Cpu
            : event.metric === "memory"
              ? MemoryStick
              : HardDrive;
          const StateIcon =
            event.kind === "triggered" ? TriangleAlert : CheckCircle2;
          return (
            <article key={event.id} className={`is-${event.kind}`}>
              <span><Icon size={15} /></span>
              <div>
                <strong>
                  {event.applicationName ??
                    t("history:watchRules.privateApplication")}
                </strong>
                <small>
                  {t(`history:watchRules.${event.kind}`, {
                    metric: t(`settings:watchRules.metrics.${event.metric}`),
                    value: event.metric === "disk"
                      ? event.value.toFixed(1)
                      : event.value.toFixed(0),
                    unit: event.metric === "cpu"
                      ? "%"
                      : event.metric === "memory"
                        ? " MiB"
                        : " MiB/s",
                  })}
                </small>
              </div>
              <em>
                <StateIcon size={13} />
                {new Date(event.timestamp).toLocaleString(
                  i18n.resolvedLanguage,
                  {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                )}
              </em>
            </article>
          );
        })}
      </div>
    </section>
  );
}
