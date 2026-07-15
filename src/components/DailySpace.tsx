import {
  ArrowRight,
  HardDrive,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  cleanupReclaimableBytes,
  primaryDailyVolume,
} from "../dailyExperience";
import type { CleanupScan, SystemSnapshot } from "../types";
import { formatBytes } from "../utils";
import { Button } from "./Button";

interface DailySpaceProps {
  snapshot: SystemSnapshot;
  cleanupSnapshot: CleanupScan | null;
  cleanupLoading: boolean;
  onOpenCleanup: () => void;
  onRefresh: () => void | Promise<void>;
}

export function DailySpace({
  snapshot,
  cleanupSnapshot,
  cleanupLoading,
  onOpenCleanup,
  onRefresh,
}: DailySpaceProps) {
  const { t, i18n } = useAppTranslation();
  const volume = primaryDailyVolume(snapshot);
  const reclaimableBytes = cleanupReclaimableBytes(cleanupSnapshot);
  const level = !volume ? "unknown" : volume.lowSpace ? "attention" : "normal";
  return (
    <section className="daily-space" aria-labelledby="daily-space-title">
      <header className={`daily-page-hero daily-space-hero is-${level}`}>
        <span className="daily-page-hero__icon"><HardDrive size={22} /></span>
        <div>
          <span className="eyebrow">{t("daily:space.kicker")}</span>
          <h1 id="daily-space-title">{t(`daily:space.${level}.title`)}</h1>
          <p>{volume ? t(`daily:space.${level}.description`, { free: formatBytes(volume.volume.availableBytes) }) : t("daily:space.unknown.description")}</p>
        </div>
        <Button variant="secondary" onClick={() => void onRefresh()}>
          <RefreshCw size={14} />{t("daily:space.checkAgain")}
        </Button>
      </header>

      {volume ? (
        <details className="daily-space-meter" aria-label={t("daily:space.capacity")} open>
          <summary>{t("daily:space.showDetails")}</summary>
          <div>
            <span><small>{t("daily:space.available")}</small><strong>{formatBytes(volume.volume.availableBytes)}</strong></span>
            <span><small>{t("daily:space.used")}</small><strong>{formatBytes(volume.usedBytes)}</strong></span>
          </div>
          <span className={`daily-space-meter__track is-${level}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(volume.usagePercent)}>
            <i style={{ width: `${volume.usagePercent}%` }} />
          </span>
          <p>{t("daily:space.usage", { percent: volume.usagePercent.toFixed(0) })}</p>
        </details>
      ) : null}

      <div className="daily-space-actions">
        <article className="daily-space-action daily-space-action--primary">
          <span><Sparkles size={22} /></span>
          <div>
            <small>{cleanupSnapshot ? t("daily:space.scan.ready") : t("daily:space.scan.notYet")}</small>
            <h2>{cleanupSnapshot ? t("daily:space.scan.found", { size: formatBytes(reclaimableBytes) }) : t("daily:space.scan.title")}</h2>
            <p>{cleanupSnapshot ? t("daily:space.scan.cached", { time: new Date(cleanupSnapshot.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" }) }) : t("daily:space.scan.description")}</p>
          </div>
          <Button variant="primary" onClick={onOpenCleanup}>
            {cleanupLoading ? <RefreshCw className="is-spinning" size={15} /> : <Sparkles size={15} />}
            {cleanupSnapshot ? t("daily:space.scan.open") : t("daily:space.scan.start")}<ArrowRight size={14} />
          </Button>
        </article>
      </div>
    </section>
  );
}
