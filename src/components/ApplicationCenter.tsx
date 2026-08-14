import { Activity, AppWindow, Clock3, Network, PackageX, Power, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import type { ApplicationImpactHistoryPoint } from "../applicationImpactHistory";
import type { ApplicationImpact } from "../diagnosis";
import type { ApplicationImpactHistoryStorageStatus } from "../hooks/useApplicationImpactHistory";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { CommandError, NetworkConnectionsSnapshot, ProcessRow, StartupItemsSnapshot, TrashedApplication } from "../types";
import type { CompleteUserActionInput, StartUserActionInput } from "../userActionHistory";
import { formatBytes, formatPercent, formatRate, processIdentity } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { ApplicationImpactHistoryPanel } from "./ApplicationImpactHistoryPanel";
import { ApplicationImpactPanel } from "./ApplicationImpactPanel";
import { ApplicationUninstallAssistant } from "./ApplicationUninstallAssistant";
import "./ApplicationCenter.css";

type ApplicationCenterTab = "activity" | "history" | "manage";

export function ApplicationCenter({
  applications,
  processes,
  totalMemoryBytes,
  historyPoints,
  historyEnabled,
  historyStorageStatus,
  onHistoryEnabledChange,
  startupSnapshot,
  connectionsSnapshot,
  onOpenStartup,
  onOpenNetwork,
  trashWatcherEnabled,
  onTrashWatcherEnabledChange,
  trashedApplications,
  trashWatcherError,
  onUserActionStart,
  onUserActionComplete,
}: {
  applications: readonly ApplicationImpact[];
  processes: readonly ProcessRow[];
  totalMemoryBytes: number;
  historyPoints: readonly ApplicationImpactHistoryPoint[];
  historyEnabled: boolean;
  historyStorageStatus: ApplicationImpactHistoryStorageStatus;
  onHistoryEnabledChange: (enabled: boolean) => void;
  startupSnapshot: StartupItemsSnapshot | null;
  connectionsSnapshot: NetworkConnectionsSnapshot | null;
  onOpenStartup: () => void;
  onOpenNetwork: () => void;
  trashWatcherEnabled: boolean;
  onTrashWatcherEnabledChange: (enabled: boolean) => void;
  trashedApplications: readonly TrashedApplication[];
  trashWatcherError: CommandError | null;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}) {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<ApplicationCenterTab>("activity");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = applications.find(({ id }) => id === selectedId) ?? applications[0] ?? null;
  const memberPids = useMemo(() => new Set(
    selected
      ? processes
          .filter((process) => selected.memberIdentities.includes(processIdentity(process)))
          .map(({ pid }) => pid)
      : [],
  ), [processes, selected]);
  const startupItems = useMemo(() => {
    if (!selected || !startupSnapshot) return [];
    const identities = [selected.applicationId, selected.name]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLocaleLowerCase());
    return startupSnapshot.items.filter((item) => [
      item.bundleId,
      item.responsibleApplication,
      item.name,
    ].some((value) => value && identities.some((identity) =>
      value.toLocaleLowerCase().includes(identity)
      || identity.includes(value.toLocaleLowerCase()))));
  }, [selected, startupSnapshot]);
  const connectionCount = connectionsSnapshot?.connections.filter((connection) =>
    connection.associatedPids.some((pid) => memberPids.has(pid))).length ?? 0;
  const historySampleCount = useMemo(() => {
    if (!selected) return 0;
    return historyPoints.reduce((count, point) => count + point.applications
      .filter((application) =>
        application.applicationId === selected.applicationId
        || application.name.toLocaleLowerCase() === selected.name.toLocaleLowerCase())
      .reduce((samples, application) => samples + application.sampleCount, 0), 0);
  }, [historyPoints, selected]);

  return (
    <section className="application-center" aria-labelledby="application-center-title">
      <header className="application-center__hero">
        <span><AppWindow size={22} /></span>
        <div>
          <small>{t("applications:center.kicker")}</small>
          <h1 id="application-center-title">{t("applications:center.title")}</h1>
          <p>{t("applications:center.description")}</p>
        </div>
        <nav aria-label={t("applications:center.tabs.label")}>
          {(["activity", "history", "manage"] as const).map((value) => (
            <button className={tab === value ? "is-active" : undefined} type="button" aria-current={tab === value ? "page" : undefined} key={value} onClick={() => setTab(value)}>
              {value === "activity" ? <Activity size={14} /> : value === "history" ? <Clock3 size={14} /> : <PackageX size={14} />}
              {t(`applications:center.tabs.${value}`)}
            </button>
          ))}
        </nav>
      </header>

      {tab === "activity" ? (
        <div className="application-center__activity">
          <ApplicationImpactPanel
            applications={applications}
            totalMemoryBytes={totalMemoryBytes}
            selectedIdentity={selected?.representativeIdentity ?? null}
            onSelect={(application) => setSelectedId(application.id)}
          />
          {selected ? (
            <aside className="application-center__identity">
              <header>
                <ApplicationAvatar name={selected.name} source={{ process: selected.iconProcess }} />
                <div><small>{t("applications:center.selected")}</small><strong>{selected.name}</strong><span>{selected.applicationId ?? t("applications:center.localIdentity")}</span></div>
              </header>
              <div className="application-center__metrics">
                <span><small>CPU</small><strong>{formatPercent(selected.cpuPercent)}</strong></span>
                <span><small>{t("applications:memory")}</small><strong>{formatBytes(selected.memoryBytes)}</strong></span>
                <span><small>{t("applications:disk")}</small><strong>{formatRate(selected.diskBytesPerSecond)}</strong></span>
              </div>
              <button type="button" onClick={onOpenStartup}>
                <Power size={15} /><span><strong>{t("applications:center.startup")}</strong><small>{t("applications:center.startupCount", { count: startupItems.length })}</small></span>
              </button>
              <button type="button" onClick={onOpenNetwork}>
                <Network size={15} /><span><strong>{t("applications:center.network")}</strong><small>{t("applications:center.connectionCount", { count: connectionCount })}</small></span>
              </button>
              <button type="button" onClick={() => setTab("history")}>
                <Clock3 size={15} /><span><strong>{t("applications:center.history")}</strong><small>{t("applications:center.historySamples", { count: historySampleCount })}</small></span>
              </button>
              <button type="button" onClick={() => setTab("manage")}>
                <PackageX size={15} /><span><strong>{t("applications:center.manage")}</strong><small>{t("applications:center.manageHint")}</small></span>
              </button>
              <footer><ShieldCheck size={13} />{t("applications:center.boundary")}</footer>
            </aside>
          ) : null}
        </div>
      ) : tab === "history" ? (
        <ApplicationImpactHistoryPanel
          points={historyPoints}
          enabled={historyEnabled}
          storageStatus={historyStorageStatus}
          onEnabledChange={onHistoryEnabledChange}
        />
      ) : (
        <ApplicationUninstallAssistant
          trashWatcherEnabled={trashWatcherEnabled}
          onTrashWatcherEnabledChange={onTrashWatcherEnabledChange}
          trashedApplications={trashedApplications}
          trashWatcherError={trashWatcherError}
          onUserActionStart={onUserActionStart}
          onUserActionComplete={onUserActionComplete}
        />
      )}
    </section>
  );
}
