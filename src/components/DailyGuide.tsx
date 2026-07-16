import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Flame,
  Gauge,
  HardDrive,
  LoaderCircle,
  Network,
  Power,
  RefreshCw,
  Rocket,
  ScanSearch,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  cleanupReclaimableBytes,
  firstUserSleepBlocker,
  primaryDailyVolume,
  type DailyAttentionItem,
  type DailyIntent,
  type DailyRecheck,
} from "../dailyExperience";
import {
  dailyIncidentDisplayLevel,
  dailyIncidentLevel,
  type DailyIncident,
} from "../dailyIncidents";
import {
  batteryWellbeingLevel,
  temperatureWellbeingLevel,
} from "../deviceWellbeing";
import type { SmartDiagnosisResult } from "../diagnosis";
import { startupAdvice } from "../startupItems";
import type {
  CleanupScan,
  CommandError,
  NetworkConnectionsSnapshot,
  StartupItemsSnapshot,
  SystemSnapshot,
  SystemSettingsDestination,
} from "../types";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, formatPercent, formatRate } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { AnimatedRobin } from "./AnimatedRobin";
import { Button } from "./Button";
import { StartupExplorer } from "./StartupExplorer";

interface DailyGuideProps {
  intent: DailyIntent;
  incident: DailyIncident | null;
  incidents: readonly DailyIncident[];
  pendingIncidentCount: number;
  diagnosis: SmartDiagnosisResult;
  snapshot: SystemSnapshot;
  cleanupSnapshot: CleanupScan | null;
  cleanupLoading: boolean;
  startupSnapshot: StartupItemsSnapshot | null;
  startupError: CommandError | null;
  startupLoading: boolean;
  connectionsSnapshot: NetworkConnectionsSnapshot | null;
  connectionsError: CommandError | null;
  connectionsLoading: boolean;
  preparingAction: boolean;
  recheck: DailyRecheck | null;
  onBack: () => void;
  onRefresh: () => void | Promise<void>;
  onOpenCleanup: () => void;
  onOpenSpace: () => void;
  onOpenApplications: () => void;
  onOpenIntent: (intent: DailyIntent) => void;
  onOpenIncident: (incident: DailyIncident) => void;
  onRefreshStartup: () => void | Promise<void>;
  onRequestClose: (identity: string, name: string) => void;
  onOpenSystemSettings: (destination: SystemSettingsDestination) => void;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}

const GUIDE_ICONS = {
  slow: Gauge,
  space: HardDrive,
  startup: Rocket,
  heat: Flame,
  network: Network,
  checkup: ScanSearch,
} as const;

export function DailyGuide(props: DailyGuideProps) {
  const { t } = useAppTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const Icon = GUIDE_ICONS[props.intent];
  const refreshedResult = props.recheck?.intent === props.intent &&
    props.recheck.outcome === "refreshed";
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className={`daily-guide daily-guide--${props.intent}`} aria-labelledby="daily-guide-title">
      <header className="daily-guide__header">
        <button className="daily-guide__back" type="button" onClick={props.onBack}><ArrowLeft size={15} />{t("daily:guide.back")}</button>
        <span className="daily-guide__icon"><Icon size={23} /></span>
        <div>
          <span className="eyebrow">{t(`daily:guide.${props.intent}.kicker`)}</span>
          <h1 id="daily-guide-title">{t(`daily:guide.${props.intent}.title`)}</h1>
          <p>{t(`daily:guide.${props.intent}.description`)}</p>
        </div>
        <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw className={refreshing ? "is-spinning" : undefined} size={14} />
          {t(refreshing ? "daily:guide.checkingAgain" : "daily:guide.checkAgain")}
        </button>
      </header>

      {refreshing ? <RecheckLoadingCard intent={props.intent} /> : props.recheck?.intent === props.intent ? (
        <RecheckCard
          recheck={props.recheck}
          intent={props.intent}
          diagnosis={props.diagnosis}
          snapshot={props.snapshot}
          cleanupSnapshot={props.cleanupSnapshot}
          startupSnapshot={props.startupSnapshot}
          connectionsSnapshot={props.connectionsSnapshot}
          incidents={props.incidents}
          pendingIncidentCount={props.pendingIncidentCount}
          preparingAction={props.preparingAction}
          onOpenCleanup={props.onOpenCleanup}
          onOpenSpace={props.onOpenSpace}
          onOpenApplications={props.onOpenApplications}
          onOpenIncident={props.onOpenIncident}
          onRequestClose={props.onRequestClose}
        />
      ) : null}

      {!refreshing && props.incident ? <IncidentGuideResult {...props} incident={props.incident} /> : null}
      {!props.incident && !refreshing && !refreshedResult && props.intent === "slow" ? <SlowGuide {...props} /> : null}
      {!props.incident && !refreshing && !refreshedResult && props.intent === "space" ? <SpaceGuide {...props} /> : null}
      {!props.incident && !refreshing && props.intent === "startup" ? <StartupGuide {...props} /> : null}
      {!props.incident && !refreshing && !refreshedResult && props.intent === "heat" ? <HeatGuide {...props} /> : null}
      {!props.incident && !refreshing && !refreshedResult && props.intent === "network" ? <NetworkGuide {...props} /> : null}
      {!props.incident && !refreshing && !refreshedResult && props.intent === "checkup" ? <CheckupGuide {...props} /> : null}
    </section>
  );
}

function IncidentGuideResult({
  incident,
  diagnosis,
  snapshot,
  cleanupSnapshot,
  preparingAction,
  onOpenCleanup,
  onOpenSpace,
  onOpenApplications,
  onOpenIntent,
  onRequestClose,
}: DailyGuideProps & { incident: DailyIncident }) {
  const { t, i18n } = useAppTranslation();
  const item = incident.item;
  const presentation = attentionPresentation(item, t);
  const tone = incident.phase === "resolved"
    ? "normal"
    : dailyIncidentDisplayLevel(incident);
  const Icon = incident.phase === "resolved"
    ? CheckCircle2
    : incident.phase === "recovering"
      ? Clock3
      : TriangleAlert;
  const liveFinding = item.kind === "diagnosis"
    ? diagnosis.findings.find(({ code }) => code === item.finding.code) ?? null
    : null;
  const liveSleep = item.kind === "sleep"
    ? firstUserSleepBlocker(diagnosis, snapshot.sensors)
    : null;
  const actionableApplication = incident.phase === "active"
    ? item.kind === "diagnosis"
      ? liveFinding?.culprit ?? null
      : item.kind === "sleep" &&
          liveSleep?.blocker.name.toLocaleLowerCase() === item.name.toLocaleLowerCase()
        ? liveSleep.application
        : null
    : null;
  const evidence = incidentEvidence(item, t);
  const startedAt = new Date(incident.activatedAtMs).toLocaleTimeString(
    i18n.resolvedLanguage,
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );
  const lastSeenAt = new Date(incident.lastObservedAtMs).toLocaleTimeString(
    i18n.resolvedLanguage,
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );
  const statusDescription = incident.phase === "recovering"
    ? t("daily:incident.recoveringDescription")
    : incident.phase === "resolved"
      ? t("daily:incident.resolvedDescription")
      : presentation.description;

  return (
    <section className={`daily-guide-result daily-incident-result is-${tone}`}>
      <span className="daily-guide-result__icon"><Icon size={23} /></span>
      <div className="daily-guide-result__content">
        <span className="eyebrow">{t(`daily:incident.phase.${incident.phase}`)}</span>
        <h2>{presentation.title}</h2>
        <p>{statusDescription}</p>
        {item.kind === "diagnosis" && item.finding.culprit ? (
          <div className="daily-guide-culprit">
            <ApplicationAvatar application={item.finding.culprit} />
            <span><small>{t("daily:incident.observedCause")}</small><strong>{item.finding.culprit.name}</strong></span>
            <em>{t("daily:incident.causeMayHaveChanged")}</em>
          </div>
        ) : null}
        <details className="daily-evidence" open={incident.phase !== "active"}>
          <summary><ScanSearch size={14} />{t("daily:guide.viewEvidence")}</summary>
          <div>
            <span>{evidence.label}</span>
            <strong>{evidence.value}</strong>
            <small>{t("daily:incident.timeline", { startedAt, lastSeenAt })}</small>
          </div>
        </details>
      </div>
      <div className="daily-guide-result__actions">
        {actionableApplication?.actionIdentity && !actionableApplication.systemComponent ? (
          <button
            className="button button--primary"
            type="button"
            disabled={preparingAction}
            onClick={() => onRequestClose(
              actionableApplication.actionIdentity!,
              actionableApplication.name,
            )}
          >
            {preparingAction
              ? <LoaderCircle className="is-spinning" size={14} />
              : <Power size={14} />}
            {t(item.kind === "sleep"
              ? "daily:guide.heat.requestClose"
              : "daily:guide.slow.requestClose", {
                name: actionableApplication.name,
              })}
          </button>
        ) : null}
        {item.kind === "diagnosis" && item.finding.category === "storage" ? (
          <>
            <button className="button button--primary" type="button" onClick={onOpenCleanup}>
              <Sparkles size={14} />
              {t(cleanupSnapshot ? "daily:guide.space.openScan" : "daily:guide.space.startScan")}
            </button>
            <button className="button button--secondary" type="button" onClick={onOpenSpace}>
              {t("daily:guide.space.viewSpace")}<ArrowRight size={14} />
            </button>
          </>
        ) : item.kind === "diagnosis" && item.finding.category === "network" ? (
          <button className="button button--secondary" type="button" onClick={() => onOpenIntent("network")}>
            {t("daily:incident.viewCurrentNetwork")}<ArrowRight size={14} />
          </button>
        ) : (
          <button className="button button--secondary" type="button" onClick={onOpenApplications}>
            <Gauge size={15} />{t(item.kind === "sleep" || item.kind === "temperature" || item.kind === "battery"
              ? "daily:guide.heat.viewApplications"
              : "daily:guide.slow.viewApplications")}
          </button>
        )}
      </div>
    </section>
  );
}

function incidentEvidence(item: DailyAttentionItem, t: AppTFunction) {
  if (item.kind === "diagnosis") {
    return {
      label: t(`diagnosis:categories.${item.finding.category}`),
      value: findingEvidence(item.finding),
    };
  }
  if (item.kind === "temperature") {
    return {
      label: t("wellbeing:temperature.label"),
      value: `${item.valueCelsius.toFixed(0)} °C`,
    };
  }
  if (item.kind === "battery") {
    return {
      label: t("wellbeing:battery.label"),
      value: `${item.chargePercent.toFixed(0)}%`,
    };
  }
  return {
    label: t("wellbeing:sleep.label"),
    value: t("daily:incident.sleepDuration", {
      minutes: Math.max(1, Math.round(item.durationSeconds / 60)),
    }),
  };
}

function SlowGuide({
  diagnosis,
  preparingAction,
  onOpenApplications,
  onRequestClose,
}: DailyGuideProps) {
  const { t } = useAppTranslation();
  const finding = useMemo(
    () => diagnosis.findings.find(({ category }) => category !== "storage") ?? null,
    [diagnosis.findings],
  );
  if (!diagnosis.baselineReady && !finding) {
    const progress = Math.min(100, diagnosis.sampleSpanMs / 10_000 * 100);
    const seconds = Math.max(1, Math.ceil((10_000 - diagnosis.sampleSpanMs) / 1_000));
    return (
      <section className="daily-guide-result is-observing">
        <span className="daily-guide-result__icon"><LoaderCircle className="is-spinning" size={23} /></span>
        <div><span className="eyebrow">{t("daily:guide.slow.observingKicker")}</span><h2>{t("daily:guide.slow.observingTitle")}</h2><p>{t("daily:guide.slow.observingDescription", { seconds })}</p></div>
        <span className="daily-guide-progress"><i style={{ width: `${progress}%` }} /></span>
      </section>
    );
  }
  if (!finding) {
    return (
      <section className="daily-guide-result is-normal">
        <span className="daily-guide-result__icon"><CheckCircle2 size={23} /></span>
        <div><span className="eyebrow">{t("daily:guide.result")}</span><h2>{t("daily:guide.slow.normalTitle")}</h2><p>{t("daily:guide.slow.normalDescription")}</p></div>
        <button className="button button--secondary" type="button" onClick={onOpenApplications}>{t("daily:guide.slow.viewApplications")}<ArrowRight size={14} /></button>
      </section>
    );
  }
  const culprit = finding.culprit;
  const actionIdentity = culprit?.actionIdentity ?? null;
  return (
    <section className={`daily-guide-result is-${finding.severity}`}>
      <span className="daily-guide-result__icon"><TriangleAlert size={23} /></span>
      <div className="daily-guide-result__content">
        <span className="eyebrow">{t("daily:guide.result")}</span>
        <h2>{t(`diagnosis:findings.${finding.code}.title`, { resource: finding.resourceLabel ?? t("diagnosis:thisDisk") })}</h2>
        <p>{t(`diagnosis:findings.${finding.code}.description`)}</p>
        {culprit ? (
          <div className="daily-guide-culprit">
            <ApplicationAvatar application={culprit} />
            <span><small>{t("daily:guide.slow.likelyCause")}</small><strong>{culprit.name}</strong></span>
            <em>{t("daily:guide.slow.applicationExplanation", { name: culprit.name })}</em>
          </div>
        ) : null}
        <details className="daily-evidence">
          <summary><ScanSearch size={14} />{t("daily:guide.viewEvidence")}</summary>
          <div><span>{t(`diagnosis:categories.${finding.category}`)}</span><strong>{findingEvidence(finding)}</strong><small>{t("diagnosis:duration", { seconds: Math.max(0, Math.round(finding.durationMs / 1_000)) })}</small></div>
        </details>
      </div>
      <div className="daily-guide-result__actions">
        {culprit && actionIdentity && !culprit.systemComponent ? (
          <button className="button button--primary" type="button" disabled={preparingAction} onClick={() => onRequestClose(actionIdentity, culprit.name)}>
            {preparingAction ? <LoaderCircle className="is-spinning" size={14} /> : <Power size={14} />}{t("daily:guide.slow.requestClose", { name: culprit.name })}
          </button>
        ) : null}
        <button className="button button--secondary" type="button" onClick={onOpenApplications}>{t("daily:guide.slow.viewApplications")}<ArrowRight size={14} /></button>
      </div>
    </section>
  );
}

function SpaceGuide({ snapshot, cleanupSnapshot, cleanupLoading, onOpenCleanup, onOpenSpace }: DailyGuideProps) {
  const { t, i18n } = useAppTranslation();
  const volume = primaryDailyVolume(snapshot);
  const reclaimable = cleanupReclaimableBytes(cleanupSnapshot);
  return (
    <section className={`daily-guide-result ${volume?.lowSpace ? "is-attention" : "is-normal"}`}>
      <span className="daily-guide-result__icon">{volume?.lowSpace ? <TriangleAlert size={23} /> : <CheckCircle2 size={23} />}</span>
      <div className="daily-guide-result__content">
        <span className="eyebrow">{t("daily:guide.result")}</span>
        <h2>{volume ? t(volume.lowSpace ? "daily:guide.space.lowTitle" : "daily:guide.space.normalTitle", { free: formatBytes(volume.volume.availableBytes) }) : t("daily:guide.space.unknownTitle")}</h2>
        <p>{!volume ? t("daily:guide.space.unknownDescription") : volume.lowSpace ? t("daily:guide.space.lowDescription") : t("daily:guide.space.normalDescription")}</p>
        {cleanupSnapshot ? (
          <div className="daily-guide-fact"><Sparkles size={18} /><span><small>{t("daily:guide.space.cachedScan")}</small><strong>{t("daily:guide.space.reclaimable", { size: formatBytes(reclaimable) })}</strong></span><em>{new Date(cleanupSnapshot.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" })}</em></div>
        ) : (
          <div className="daily-guide-fact"><Clock3 size={18} /><span><small>{t("daily:guide.space.noScan")}</small><strong>{t("daily:guide.space.scanExplanation")}</strong></span></div>
        )}
      </div>
      <div className="daily-guide-result__actions">
        <button className="button button--primary" type="button" onClick={onOpenCleanup}>{cleanupLoading ? <RefreshCw className="is-spinning" size={14} /> : <Sparkles size={14} />}{cleanupSnapshot ? t("daily:guide.space.openScan") : t("daily:guide.space.startScan")}</button>
        <button className="button button--secondary" type="button" onClick={onOpenSpace}>{t("daily:guide.space.viewSpace")}<ArrowRight size={14} /></button>
      </div>
    </section>
  );
}

function StartupGuide(props: DailyGuideProps) {
  const { t } = useAppTranslation();
  return (
    <section className="daily-guide-embedded">
      <div className="daily-guide-embedded__intro">
        <Rocket size={19} />
        <div><strong>{t("daily:guide.startup.resultTitle")}</strong><span>{t("daily:guide.startup.resultDescription")}</span></div>
        <Button variant="secondary" onClick={() => props.onOpenSystemSettings("login_items")}>
          <ExternalLink size={14} />{t("common:systemSettings.login_items")}
        </Button>
      </div>
      <StartupExplorer
        variant="guided"
        snapshot={props.startupSnapshot}
        error={props.startupError}
        loading={props.startupLoading}
        applications={props.diagnosis.applications}
        totalMemoryBytes={props.snapshot.memory.totalBytes}
        onRefresh={props.onRefreshStartup}
        onUserActionStart={props.onUserActionStart}
        onUserActionComplete={props.onUserActionComplete}
      />
    </section>
  );
}

function HeatGuide({ diagnosis, snapshot, preparingAction, onOpenApplications, onRequestClose, onOpenSystemSettings }: DailyGuideProps) {
  const { t } = useAppTranslation();
  const temperature = temperatureWellbeingLevel(snapshot.sensors.temperature);
  const battery = batteryWellbeingLevel(snapshot.sensors.battery);
  const sleep = firstUserSleepBlocker(diagnosis, snapshot.sensors);
  const sleepAvailable = snapshot.sensors.sleep.available;
  const unavailable = temperature === "unavailable" && battery === "unavailable" && !sleepAvailable;
  const tone = temperature === "urgent" || battery === "urgent"
    ? "urgent"
    : temperature === "attention" || battery === "attention" || sleep
      ? "attention"
      : unavailable
        ? "observing"
        : "normal";
  const cause = temperature === "attention" || temperature === "urgent"
    ? "temperature"
    : battery === "attention" || battery === "urgent"
      ? "battery"
      : sleep
        ? "sleep"
        : unavailable
          ? "unknown"
          : "normal";
  return (
    <section className={`daily-guide-result is-${tone}`}>
      <span className="daily-guide-result__icon">{tone === "normal" ? <CheckCircle2 size={23} /> : tone === "observing" ? <Clock3 size={23} /> : <Flame size={23} />}</span>
      <div className="daily-guide-result__content">
        <span className="eyebrow">{t("daily:guide.result")}</span>
        <h2>{cause === "sleep"
          ? t("daily:guide.heat.result.sleep.title", { name: sleep?.blocker.name ?? "" })
          : t(`daily:guide.heat.result.${cause}.title`)}</h2>
        <p>{t(`daily:guide.heat.result.${cause}.description`)}</p>
        <details className="daily-evidence">
          <summary><ScanSearch size={14} />{t("daily:guide.viewEvidence")}</summary>
          <div className="daily-wellbeing-evidence">
            <span><small>{t("wellbeing:temperature.label")}</small><strong>{snapshot.sensors.temperature.celsius === null ? t("common:unknown") : `${snapshot.sensors.temperature.celsius.toFixed(0)} °C`}</strong></span>
            <span><small>{t("wellbeing:battery.label")}</small><strong>{!snapshot.sensors.battery.present || snapshot.sensors.battery.chargePercent === null ? t("wellbeing:battery.notPresent") : `${snapshot.sensors.battery.chargePercent.toFixed(0)}%`}</strong></span>
            <span><small>{t("wellbeing:battery.healthLabel")}</small><strong>{snapshot.sensors.battery.healthPercent === null ? t("common:unavailable") : formatPercent(snapshot.sensors.battery.healthPercent)}</strong></span>
            <span><small>{t("wellbeing:battery.cycleCountLabel")}</small><strong>{snapshot.sensors.battery.cycleCount === null ? t("common:unavailable") : snapshot.sensors.battery.cycleCount.toLocaleString()}</strong></span>
            <span><small>{t("wellbeing:sleep.label")}</small><strong>{!sleepAvailable ? t("wellbeing:sleep.unavailableValue") : sleep ? t("wellbeing:sleep.blockedValue", { count: 1 }) : t("wellbeing:sleep.clearValue")}</strong></span>
          </div>
        </details>
      </div>
      <div className="daily-guide-result__actions">
        {sleep?.application?.actionIdentity && !sleep.application.systemComponent ? (
          <button className="button button--primary" type="button" disabled={preparingAction} onClick={() => onRequestClose(sleep.application!.actionIdentity!, sleep.application!.name)}>{preparingAction ? <LoaderCircle className="is-spinning" size={14} /> : <Power size={14} />}{t("daily:guide.heat.requestClose", { name: sleep.application.name })}</button>
        ) : null}
        {(tone === "attention" || tone === "urgent") ? <button className="button button--secondary" type="button" onClick={onOpenApplications}><Gauge size={15} />{t("daily:guide.heat.viewApplications")}</button> : null}
        <Button variant="secondary" onClick={() => onOpenSystemSettings("battery")}><ExternalLink size={14} />{t("common:systemSettings.battery")}</Button>
      </div>
    </section>
  );
}

function NetworkGuide({
  snapshot,
  connectionsSnapshot,
  connectionsError,
  connectionsLoading,
  onOpenSystemSettings,
}: DailyGuideProps) {
  const { t } = useAppTranslation();
  const received = snapshot.network.receivedBytesPerSecond;
  const transmitted = snapshot.network.transmittedBytesPerSecond;
  const rate = received === null || transmitted === null
    ? null
    : received + transmitted;
  if (connectionsLoading && !connectionsSnapshot) {
    return (
      <section className="daily-guide-result is-observing">
        <span className="daily-guide-result__icon"><LoaderCircle className="is-spinning" size={23} /></span>
        <div><span className="eyebrow">{t("daily:guide.network.checkingKicker")}</span><h2>{t("daily:guide.network.checkingTitle")}</h2><p>{t("daily:guide.network.checkingDescription")}</p></div>
      </section>
    );
  }
  const unavailable = rate === null && (!connectionsSnapshot || connectionsError);
  return (
    <section className={`daily-guide-result is-${unavailable ? "observing" : "normal"}`}>
      <span className="daily-guide-result__icon">{unavailable ? <Clock3 size={23} /> : <CheckCircle2 size={23} />}</span>
      <div className="daily-guide-result__content">
        <span className="eyebrow">{t("daily:guide.result")}</span>
        <h2>{t(unavailable ? "daily:guide.network.unknownTitle" : rate && rate > 0 ? "daily:guide.network.activeTitle" : "daily:guide.network.quietTitle")}</h2>
        <p>{t(unavailable ? "daily:guide.network.unknownDescription" : "daily:guide.network.resultDescription")}</p>
        <details className="daily-evidence">
          <summary><ScanSearch size={14} />{t("daily:guide.viewEvidence")}</summary>
          <div>
            <span>{t("daily:guide.network.currentTraffic")}</span>
            <strong>{rate === null ? t("common:unknown") : formatRate(rate)}</strong>
            {connectionsSnapshot ? <small>{t("daily:guide.network.connections", { count: connectionsSnapshot.summary.totalCount })}</small> : null}
          </div>
        </details>
      </div>
      <div className="daily-guide-result__actions">
        <Button variant="secondary" onClick={() => onOpenSystemSettings("network")}><ExternalLink size={14} />{t("common:systemSettings.network")}</Button>
      </div>
    </section>
  );
}

function CheckupGuide({
  diagnosis,
  incidents,
  pendingIncidentCount,
  onOpenIncident,
}: DailyGuideProps) {
  const { t } = useAppTranslation();
  const primary = incidents[0] ?? null;
  const level = dailyIncidentLevel(
    incidents,
    diagnosis.baselineReady,
    pendingIncidentCount,
  );
  if (level === "observing" && !primary) {
    const progress = Math.min(100, diagnosis.sampleSpanMs / 10_000 * 100);
    const seconds = Math.max(1, Math.ceil((10_000 - diagnosis.sampleSpanMs) / 1_000));
    return (
      <section className="daily-guide-result is-observing">
        <span className="daily-guide-result__icon"><LoaderCircle className="is-spinning" size={23} /></span>
        <div><span className="eyebrow">{t("daily:guide.checkup.observingKicker")}</span><h2>{t("daily:guide.checkup.observingTitle")}</h2><p>{t("daily:guide.checkup.observingDescription", { seconds })}</p></div>
        <span className="daily-guide-progress"><i style={{ width: `${progress}%` }} /></span>
      </section>
    );
  }
  if (!primary) {
    return (
      <section className="daily-guide-result is-normal">
        <span className="daily-guide-result__icon"><CheckCircle2 size={23} /></span>
        <div><span className="eyebrow">{t("daily:guide.result")}</span><h2>{t("daily:guide.checkup.normalTitle")}</h2><p>{t("daily:guide.checkup.normalDescription")}</p></div>
      </section>
    );
  }
  const presentation = attentionPresentation(primary.item, t);
  return (
    <section className={`daily-guide-result is-${dailyIncidentDisplayLevel(primary)}`}>
      <span className="daily-guide-result__icon"><TriangleAlert size={23} /></span>
      <div><span className="eyebrow">{t("daily:guide.checkup.priorityKicker")}</span><h2>{presentation.title}</h2><p>{presentation.description}</p></div>
      <div className="daily-guide-result__actions"><button className="button button--primary" type="button" onClick={() => onOpenIncident(primary)}>{t("daily:guide.checkup.openPriority")}<ArrowRight size={14} /></button></div>
    </section>
  );
}

function attentionPresentation(
  item: DailyAttentionItem,
  t: AppTFunction,
) {
  if (item.kind === "diagnosis") {
    return {
      title: t(`diagnosis:findings.${item.finding.code}.title`, {
        resource: item.finding.resourceLabel ?? t("diagnosis:thisDisk"),
      }),
      description: t(`diagnosis:findings.${item.finding.code}.description`),
    };
  }
  if (item.kind === "sleep") {
    return {
      title: t("daily:attention.sleep.title", { name: item.name }),
      description: t("daily:attention.sleep.description"),
    };
  }
  return {
    title: t(`daily:attention.${item.kind}.title`),
    description: t(`daily:attention.${item.kind}.description`),
  };
}

interface RecheckCardProps {
  recheck: DailyRecheck;
  intent: DailyIntent;
  diagnosis: SmartDiagnosisResult;
  snapshot: SystemSnapshot;
  cleanupSnapshot: CleanupScan | null;
  startupSnapshot: StartupItemsSnapshot | null;
  connectionsSnapshot: NetworkConnectionsSnapshot | null;
  incidents: readonly DailyIncident[];
  pendingIncidentCount: number;
  preparingAction: boolean;
  onOpenCleanup: () => void;
  onOpenSpace: () => void;
  onOpenApplications: () => void;
  onOpenIncident: (incident: DailyIncident) => void;
  onRequestClose: (identity: string, name: string) => void;
}

interface RecheckPresentation {
  tone: "observing" | "normal" | "attention" | "urgent";
  title: string;
  description: string;
  facts: Array<{ label: string; value: string }>;
}

function RecheckCard({
  recheck,
  intent,
  diagnosis,
  snapshot,
  cleanupSnapshot,
  startupSnapshot,
  connectionsSnapshot,
  incidents,
  pendingIncidentCount,
  preparingAction,
  onOpenCleanup,
  onOpenSpace,
  onOpenApplications,
  onOpenIncident,
  onRequestClose,
}: RecheckCardProps) {
  const { t, i18n } = useAppTranslation();
  const presentation = recheckPresentation(
    recheck,
    intent,
    diagnosis,
    snapshot,
    startupSnapshot,
    connectionsSnapshot,
    incidents,
    pendingIncidentCount,
    t,
  );
  const completedAt = new Date(recheck.checkedAtMs).toLocaleTimeString(
    i18n.resolvedLanguage,
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );
  const Icon = presentation.tone === "urgent"
    ? TriangleAlert
    : presentation.tone === "attention"
      ? Clock3
      : presentation.tone === "observing"
        ? RefreshCw
        : CheckCircle2;
  const finding = intent === "slow"
    ? diagnosis.findings.find(({ category }) => category !== "storage") ?? null
    : null;
  const culprit = finding?.culprit ?? null;
  const sleep = intent === "heat"
    ? firstUserSleepBlocker(diagnosis, snapshot.sensors)
    : null;
  const primary = intent === "checkup"
    ? incidents[0] ?? null
    : null;
  return (
    <div className={`daily-recheck daily-recheck--result is-${presentation.tone}`} role="status" aria-live="polite">
      <div className="daily-recheck__visual" aria-hidden="true">
        <span><Icon size={23} /></span>
        <i className="daily-recheck__spark daily-recheck__spark--1" />
        <i className="daily-recheck__spark daily-recheck__spark--2" />
        <i className="daily-recheck__spark daily-recheck__spark--3" />
      </div>
      <div className="daily-recheck__content">
        <small>{t("daily:recheck.resultKicker")}</small>
        <strong>{presentation.title}</strong>
        <span>{presentation.description}</span>
        {presentation.facts.length > 0 ? (
          <details className="daily-recheck__evidence">
            <summary><ScanSearch size={13} />{t("daily:guide.viewEvidence")}</summary>
            <dl className="daily-recheck__facts">
              {presentation.facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
        <div className="daily-recheck__actions">
          {intent === "slow" && culprit?.actionIdentity && !culprit.systemComponent ? (
            <button className="button button--primary" type="button" disabled={preparingAction} onClick={() => onRequestClose(culprit.actionIdentity!, culprit.name)}>
              {preparingAction ? <LoaderCircle className="is-spinning" size={14} /> : <Power size={14} />}
              {t("daily:guide.slow.requestClose", { name: culprit.name })}
            </button>
          ) : null}
          {intent === "space" ? (
            <button className="button button--primary" type="button" onClick={onOpenCleanup}>
              <Sparkles size={14} />
              {t(cleanupSnapshot ? "daily:guide.space.openScan" : "daily:guide.space.startScan")}
            </button>
          ) : null}
          {intent === "heat" && sleep?.application?.actionIdentity && !sleep.application.systemComponent ? (
            <button className="button button--primary" type="button" disabled={preparingAction} onClick={() => onRequestClose(sleep.application!.actionIdentity!, sleep.application!.name)}>
              {preparingAction ? <LoaderCircle className="is-spinning" size={14} /> : <Power size={14} />}
              {t("daily:guide.heat.requestClose", { name: sleep.application.name })}
            </button>
          ) : null}
          {intent === "checkup" && primary ? (
            <button className="button button--primary" type="button" onClick={() => onOpenIncident(primary)}>{t("daily:guide.checkup.openPriority")}<ArrowRight size={14} /></button>
          ) : null}
          {intent === "space" ? (
            <button className="button button--secondary" type="button" onClick={onOpenSpace}>{t("daily:guide.space.viewSpace")}<ArrowRight size={14} /></button>
          ) : intent === "slow" || intent === "heat" ? (
            <button className="button button--secondary" type="button" onClick={onOpenApplications}>{intent === "heat" ? t("daily:guide.heat.viewApplications") : t("daily:guide.slow.viewApplications")}<ArrowRight size={14} /></button>
          ) : null}
        </div>
      </div>
      <div className="daily-recheck__meta">
        <span><i />{t("daily:recheck.completed")}</span>
        <time dateTime={new Date(recheck.checkedAtMs).toISOString()}>{t("daily:recheck.completedAt", { time: completedAt })}</time>
      </div>
    </div>
  );
}

function recheckPresentation(
  recheck: DailyRecheck,
  intent: DailyIntent,
  diagnosis: SmartDiagnosisResult,
  snapshot: SystemSnapshot,
  startupSnapshot: StartupItemsSnapshot | null,
  connectionsSnapshot: NetworkConnectionsSnapshot | null,
  incidents: readonly DailyIncident[],
  pendingIncidentCount: number,
  t: AppTFunction,
): RecheckPresentation {
  if (recheck.outcome !== "refreshed") {
    const tone = recheck.outcome === "still_running" ? "attention" : "normal";
    return {
      tone,
      title: t(`daily:recheck.outcomeTitle.${recheck.outcome}`),
      description: t(`daily:recheck.${recheck.outcome}`),
      facts: [],
    };
  }

  if (intent === "slow") {
    const finding = diagnosis.findings.find(({ category }) => category !== "storage") ?? null;
    if (finding) {
      return {
        tone: finding.severity,
        title: t(`diagnosis:findings.${finding.code}.title`, {
          resource: finding.resourceLabel ?? t("diagnosis:thisDisk"),
        }),
        description: t(`diagnosis:findings.${finding.code}.description`),
        facts: [
          { label: t("daily:recheck.facts.currentReading"), value: findingEvidence(finding) },
          {
            label: t("daily:recheck.facts.observedFor"),
            value: t("daily:recheck.facts.seconds", {
              count: Math.max(1, Math.round(finding.durationMs / 1_000)),
            }),
          },
        ],
      };
    }
    if (!diagnosis.baselineReady) {
      return {
        tone: "observing",
        title: t("daily:guide.slow.observingTitle"),
        description: t("daily:recheck.slow.observingDescription"),
        facts: [],
      };
    }
    return {
      tone: "normal",
      title: t("daily:guide.slow.normalTitle"),
      description: t("daily:guide.slow.normalDescription"),
      facts: [{ label: t("daily:recheck.facts.sustainedPressure"), value: t("daily:recheck.facts.notFound") }],
    };
  }

  if (intent === "space") {
    const volume = primaryDailyVolume(snapshot);
    if (!volume) {
      return {
        tone: "observing",
        title: t("daily:guide.space.unknownTitle"),
        description: t("daily:guide.space.unknownDescription"),
        facts: [],
      };
    }
    return {
      tone: volume.lowSpace ? "attention" : "normal",
      title: t(volume.lowSpace ? "daily:guide.space.lowTitle" : "daily:guide.space.normalTitle", {
        free: formatBytes(volume.volume.availableBytes),
      }),
      description: t(volume.lowSpace ? "daily:guide.space.lowDescription" : "daily:guide.space.normalDescription"),
      facts: [
        { label: t("daily:space.available"), value: formatBytes(volume.volume.availableBytes) },
        { label: t("daily:space.used"), value: formatPercent(volume.usagePercent) },
      ],
    };
  }

  if (intent === "startup") {
    if (!startupSnapshot) {
      return {
        tone: "observing",
        title: t("daily:recheck.startup.unavailableTitle"),
        description: t("daily:recheck.startup.unavailableDescription"),
        facts: [],
      };
    }
    const reviewCount = startupSnapshot.items.filter(
      (item) => startupAdvice(item) === "review",
    ).length;
    return {
      tone: reviewCount > 0 ? "attention" : "normal",
      title: reviewCount > 0
        ? t("startup:guided.found", { count: reviewCount })
        : t("startup:guided.clear"),
      description: reviewCount > 0
        ? t("startup:guided.foundDescription")
        : t("startup:guided.clearDescription"),
      facts: [
        { label: t("daily:recheck.facts.worthReviewing"), value: String(reviewCount) },
        { label: t("daily:recheck.facts.startupTotal"), value: String(startupSnapshot.items.length) },
      ],
    };
  }

  if (intent === "network") {
    const received = snapshot.network.receivedBytesPerSecond;
    const transmitted = snapshot.network.transmittedBytesPerSecond;
    const rate = received === null || transmitted === null
      ? null
      : received + transmitted;
    return {
      tone: rate === null && !connectionsSnapshot ? "observing" : "normal",
      title: t(rate === null && !connectionsSnapshot
        ? "daily:guide.network.unknownTitle"
        : rate && rate > 0
          ? "daily:guide.network.activeTitle"
          : "daily:guide.network.quietTitle"),
      description: t(rate === null && !connectionsSnapshot
        ? "daily:guide.network.unknownDescription"
        : "daily:guide.network.resultDescription"),
      facts: [
        { label: t("daily:guide.network.currentTraffic"), value: rate === null ? t("common:unknown") : formatRate(rate) },
        ...(connectionsSnapshot ? [{ label: t("daily:guide.network.activeConnections"), value: String(connectionsSnapshot.summary.totalCount) }] : []),
      ],
    };
  }

  if (intent === "checkup") {
    const primary = incidents[0] ?? null;
    if (primary) {
      const presentation = attentionPresentation(primary.item, t);
      return {
        tone: dailyIncidentDisplayLevel(primary),
        title: presentation.title,
        description: presentation.description,
        facts: [],
      };
    }
    if (!diagnosis.baselineReady || pendingIncidentCount > 0) {
      return {
        tone: "observing",
        title: t("daily:guide.checkup.observingTitle"),
        description: t("daily:recheck.checkup.observingDescription"),
        facts: [],
      };
    }
    return {
      tone: "normal",
      title: t("daily:guide.checkup.normalTitle"),
      description: t("daily:guide.checkup.normalDescription"),
      facts: [],
    };
  }

  const temperature = temperatureWellbeingLevel(snapshot.sensors.temperature);
  const battery = batteryWellbeingLevel(snapshot.sensors.battery);
  const sleep = firstUserSleepBlocker(diagnosis, snapshot.sensors);
  const sleepAvailable = snapshot.sensors.sleep.available;
  const tone = temperature === "urgent" || battery === "urgent"
    ? "urgent"
    : temperature === "attention" || battery === "attention" || sleep
      ? "attention"
      : temperature === "unavailable" && battery === "unavailable" && !sleepAvailable
        ? "observing"
        : "normal";
  return {
    tone,
    title: t(`daily:recheck.heat.${tone}.title`),
    description: t(`daily:recheck.heat.${tone}.description`),
    facts: [
      {
        label: t("wellbeing:temperature.label"),
        value: snapshot.sensors.temperature.celsius === null
          ? t("common:unknown")
          : `${snapshot.sensors.temperature.celsius.toFixed(0)} °C`,
      },
      {
        label: t("wellbeing:battery.label"),
        value: !snapshot.sensors.battery.present || snapshot.sensors.battery.chargePercent === null
          ? t("wellbeing:battery.notPresent")
          : `${snapshot.sensors.battery.chargePercent.toFixed(0)}%`,
      },
      {
        label: t("wellbeing:battery.healthLabel"),
        value: snapshot.sensors.battery.healthPercent === null
          ? t("common:unavailable")
          : formatPercent(snapshot.sensors.battery.healthPercent),
      },
      {
        label: t("wellbeing:battery.cycleCountLabel"),
        value: snapshot.sensors.battery.cycleCount === null
          ? t("common:unavailable")
          : snapshot.sensors.battery.cycleCount.toLocaleString(),
      },
      {
        label: t("wellbeing:sleep.label"),
        value: !sleepAvailable
          ? t("wellbeing:sleep.unavailableValue")
          : sleep
            ? t("wellbeing:sleep.blockedValue", { count: 1 })
            : t("wellbeing:sleep.clearValue"),
      },
    ],
  };
}

function RecheckLoadingCard({ intent }: { intent: DailyIntent }) {
  const { t } = useAppTranslation();
  return (
    <div className="daily-recheck daily-recheck--loading" role="status" aria-live="polite">
      <i className="daily-recheck__beam" aria-hidden="true" />
      <div className="daily-recheck__visual" aria-hidden="true">
        <AnimatedRobin active interactive={false} mood="observing" size={112} />
      </div>
      <div className="daily-recheck__content">
        <small>{t("daily:recheck.loadingKicker")}</small>
        <strong>{t(`daily:recheck.live.${intent}.title`)}</strong>
        <span>{t(`daily:recheck.live.${intent}.description`)}</span>
        <span className="daily-recheck__progress" aria-hidden="true"><i /></span>
      </div>
      <span className="daily-recheck__signal" aria-hidden="true"><i /><i /><i /></span>
      </div>
  );
}

function findingEvidence(finding: SmartDiagnosisResult["findings"][number]) {
  if (finding.category === "cpu" || finding.category === "memory" || finding.category === "storage") return formatPercent(finding.value);
  return formatRate(finding.value);
}
