import { lazy, type Dispatch, type SetStateAction } from "react";
import type { ActiveView } from "../appNavigation";
import type { SmartDiagnosisResult } from "../diagnosis";
import type { AppSettings } from "../settings";
import type { CommandError, ProcessRow, SystemSnapshot, NetworkConnectionsSnapshot } from "../types";
import type { ProcessExplorerPreferences } from "../processExplorer";
import type { StartupImpactMeasurement } from "../startupImpact";
import type { ProductDataClearResult } from "../productDataClear";
import type { useCleanupScan } from "../hooks/useCleanupScan";
import type { useFileInsightsScan } from "../hooks/useFileInsightsScan";
import type { useGpuEnergyMonitor } from "../hooks/useGpuEnergyMonitor";
import type { useStartupItems } from "../hooks/useStartupItems";
import type { useUserActionHistory } from "../hooks/useUserActionHistory";
import type { useTrashApplicationWatcher } from "../hooks/useTrashApplicationWatcher";
import type { usePersistentHistory } from "../hooks/usePersistentHistory";
import type { useApplicationImpactHistory } from "../hooks/useApplicationImpactHistory";
import type { useResourceAlerts } from "../hooks/useResourceAlerts";
import type { useApplicationWatchRules } from "../hooks/useApplicationWatchRules";
import type { useNetworkQualityMonitor } from "../hooks/useNetworkQualityMonitor";
import type { ProductDataPrivacyController } from "../hooks/useProductDataPrivacy";
import { processIdentity } from "../utils";
import type { BusinessFormId } from "./formCatalog";

const DeviceWellbeing = lazy(async () => ({ default: (await import("../components/DeviceWellbeing")).default }));
const GpuEnergyPanel = lazy(async () => ({ default: (await import("../components/GpuEnergyPanel")).GpuEnergyPanel }));
const ProcessTable = lazy(async () => ({ default: (await import("../components/ProcessTable")).ProcessTable }));
const CleanupOperation = lazy(async () => ({ default: (await import("../components/CleanupAssistant")).CleanupOperation }));
const FileInsightsExplorer = lazy(async () => ({ default: (await import("../components/FileInsightsExplorer")).FileInsightsExplorer }));
const ApplicationUninstallAssistant = lazy(async () => ({ default: (await import("../components/ApplicationUninstallAssistant")).ApplicationUninstallAssistant }));
const ApplicationImpactPanel = lazy(async () => ({ default: (await import("../components/ApplicationImpactPanel")).ApplicationImpactPanel }));
const StartupExplorer = lazy(async () => ({ default: (await import("../components/StartupExplorer")).StartupExplorer }));
const NetworkQualityPanel = lazy(async () => ({ default: (await import("../components/NetworkExplorer")).NetworkQualityPanel }));
const NetworkConnectionsPanel = lazy(async () => ({ default: (await import("../components/NetworkExplorer")).NetworkConnectionsPanel }));
const StorageVolumeOperations = lazy(async () => ({ default: (await import("../components/StorageExplorer")).StorageVolumeOperations }));
const SystemEventReplay = lazy(async () => ({ default: (await import("../components/SystemEventReplay")).SystemEventReplay }));
const PersonalBaselinePanel = lazy(async () => ({ default: (await import("../components/PersonalBaselinePanel")).PersonalBaselinePanel }));
const HistoryExportPanel = lazy(async () => ({ default: (await import("../components/HistoryExportPanel")).HistoryExportPanel }));
const SmartDiagnosis = lazy(async () => ({ default: (await import("../components/SmartDiagnosis")).default }));
const HistoryRecordingControls = lazy(async () => ({ default: (await import("../components/SettingsExplorer")).HistoryRecordingControls }));
const PrivacyDataControls = lazy(async () => ({ default: (await import("../components/SettingsExplorer")).PrivacyDataControls }));

export interface BusinessOperationState {
  snapshot: SystemSnapshot; activeDiagnosis: SmartDiagnosisResult;
  cleanupScan: ReturnType<typeof useCleanupScan>; fileInsights: ReturnType<typeof useFileInsightsScan>;
  gpuEnergy: ReturnType<typeof useGpuEnergyMonitor>; startupItems: ReturnType<typeof useStartupItems>;
  connectionsSnapshot: NetworkConnectionsSnapshot | null; connectionsError: CommandError | null;
  connectionsLoading: boolean; paused: boolean; setPaused: Dispatch<SetStateAction<boolean>>; refreshConnections: () => Promise<unknown>;
  settings: AppSettings; updateSettings: (update: Partial<Omit<AppSettings, "version">>) => void;
  selectProcess: (process: ProcessRow) => void; setActiveView: (view: ActiveView) => void;
  selectedIdentity: string | null; processPreferences: ProcessExplorerPreferences;
  updateProcessPreferences: (update: Partial<ProcessExplorerPreferences>) => void;
  userActions: ReturnType<typeof useUserActionHistory>; trashApplicationWatcher: ReturnType<typeof useTrashApplicationWatcher>;
  startupImpactMeasurements: readonly StartupImpactMeasurement[]; updateLaunchAtLogin: (enabled: boolean) => void;
  refreshNow: () => Promise<unknown>;
  persistentHistory: ReturnType<typeof usePersistentHistory>; applicationImpactHistory: ReturnType<typeof useApplicationImpactHistory>;
  resourceAlerts: ReturnType<typeof useResourceAlerts>; applicationWatchRules: ReturnType<typeof useApplicationWatchRules>;
  networkQuality: ReturnType<typeof useNetworkQualityMonitor>;
  diagnosisExpanded: boolean; preparingAction: boolean; setDiagnosisExpanded: Dispatch<SetStateAction<boolean>>;
  beginDiagnosisRequestClose: (identity: string, name: string) => Promise<unknown>;
  productDataPrivacy: ProductDataPrivacyController; clearAllProductData: () => Promise<ProductDataClearResult[]>;
}

/** Lazy view composition, using the App's controllers rather than page instances. */
export function BusinessOperations({ id, onExit: exit, data }: { id: BusinessFormId; onExit: () => void; data: BusinessOperationState }) {
  const { snapshot, activeDiagnosis, cleanupScan, fileInsights, gpuEnergy, startupItems, connectionsSnapshot, connectionsError, connectionsLoading, paused, setPaused, refreshConnections, settings, updateSettings, selectProcess, setActiveView, selectedIdentity, processPreferences, updateProcessPreferences, userActions, trashApplicationWatcher, startupImpactMeasurements, updateLaunchAtLogin, refreshNow, persistentHistory, applicationImpactHistory, resourceAlerts, applicationWatchRules, networkQuality, diagnosisExpanded, preparingAction, setDiagnosisExpanded, beginDiagnosisRequestClose, productDataPrivacy, clearAllProductData } = data;
    const inspect = (identity: string) => {
      const process = snapshot.processes.find((candidate) => processIdentity(candidate) === identity);
      if (process) { exit(); selectProcess(process); setActiveView("processes"); }
    };
    switch (id) {
      case "storage.scan":
      case "storage.cleanup": return <CleanupOperation snapshot={cleanupScan.snapshot} error={cleanupScan.error} loading={cleanupScan.loading} cancelling={cleanupScan.cancelling} phase={cleanupScan.phase} progress={cleanupScan.progress} snapshotStatus={cleanupScan.snapshotStatus} growthComparison={cleanupScan.growthComparison} volumes={snapshot.disk.volumes} onScan={(target) => void cleanupScan.scan(target)} onCancel={() => void cleanupScan.cancel()} onDeletionApplied={cleanupScan.applyDeletion} directoryRefreshStatus={cleanupScan.directoryRefreshStatus} directoryRefreshError={cleanupScan.directoryRefreshError} onRefreshDirectory={(id) => void cleanupScan.refreshDirectory(id)} onCancelDirectoryRefresh={() => void cleanupScan.cancelDirectoryRefresh()} onReloadLatestSnapshot={cleanupScan.reloadLatestSnapshot} onUserActionStart={userActions.start} onUserActionComplete={userActions.complete} />;
      case "processes.usage":
      case "processes.control": return <ProcessTable processes={snapshot.processes} connections={connectionsSnapshot?.connections} selectedIdentity={selectedIdentity} onSelect={(process) => inspect(processIdentity(process))} query={processPreferences.query} onQueryChange={(query) => updateProcessPreferences({ query })} sortKey={processPreferences.sortKey} direction={processPreferences.sortDirection} liveSort={processPreferences.liveSort} onLiveSortChange={(liveSort) => updateProcessPreferences({ liveSort })} onSortChange={(sortKey, sortDirection) => updateProcessPreferences({ sortKey, sortDirection })} viewMode={processPreferences.viewMode} onViewModeChange={(viewMode) => updateProcessPreferences({ viewMode })} expandedIdentities={processPreferences.expandedIdentities} onExpandedIdentitiesChange={(expandedIdentities) => updateProcessPreferences({ expandedIdentities })} followSelection={processPreferences.followSelection} onFollowSelectionChange={(followSelection) => updateProcessPreferences({ followSelection })} />;
      case "network.quality": return <NetworkQualityPanel monitor={networkQuality} historyEnabled={settings.networkQualityHistoryEnabled} historyHours={settings.networkQualityHistoryHours} onHistoryEnabledChange={(networkQualityHistoryEnabled) => updateSettings({ networkQualityHistoryEnabled })} onHistoryHoursChange={(networkQualityHistoryHours) => updateSettings({ networkQualityHistoryHours })} />;
      case "device.status": return <DeviceWellbeing sensors={snapshot.sensors} warmingUp={snapshot.warmingUp} applications={activeDiagnosis.applications} onInspectSleepBlocker={inspect} />;
      case "device.gpu_energy": return <GpuEnergyPanel processes={snapshot.processes} controller={gpuEnergy} />;
      case "storage.file_insights": return <FileInsightsExplorer scan={fileInsights.snapshot} snapshotStatus={fileInsights.snapshotStatus} progress={fileInsights.progress} loading={fileInsights.loading} error={fileInsights.error} onRun={() => void fileInsights.scan()} onCancel={() => void fileInsights.cancel()} onFilesRemoved={fileInsights.removePaths} onDeletionApplied={cleanupScan.applyDeletion} onUserActionStart={userActions.start} onUserActionComplete={userActions.complete} />;
      case "applications.manage": return <ApplicationUninstallAssistant trashWatcherEnabled={settings.trashApplicationWatcherEnabled} onTrashWatcherEnabledChange={(trashApplicationWatcherEnabled) => updateSettings({ trashApplicationWatcherEnabled })} trashedApplications={trashApplicationWatcher.applications} trashWatcherError={trashApplicationWatcher.error} onUserActionStart={userActions.start} onUserActionComplete={userActions.complete} />;
      case "applications.activity": return <ApplicationImpactPanel applications={activeDiagnosis.applications} totalMemoryBytes={snapshot.memory.totalBytes} selectedIdentity={selectedIdentity} onSelect={(application) => inspect(application.representativeIdentity)} />;
      case "startup.manage": return <StartupExplorer snapshot={startupItems.snapshot} error={startupItems.error} loading={startupItems.loading} applications={activeDiagnosis.applications} totalMemoryBytes={snapshot.memory.totalBytes} impactMeasurements={startupImpactMeasurements} actionRecords={userActions.records} launchAtLogin={settings.launchAtLogin} onRefresh={startupItems.refresh} onEnableLaunchAtLogin={() => updateLaunchAtLogin(true)} onUserActionStart={userActions.start} onUserActionComplete={userActions.complete} />;
      case "network.connections": return <NetworkConnectionsPanel snapshot={connectionsSnapshot} error={connectionsError} loading={connectionsLoading} paused={paused} onRefresh={() => void refreshConnections()} onResume={() => setPaused(false)} refreshIntervalMs={settings.connectionRefreshIntervalMs} processes={snapshot.processes} onSelectProcess={(process) => inspect(processIdentity(process))} />;
      case "storage.volumes":
      case "storage.eject": return <StorageVolumeOperations disk={snapshot.disk} usageThresholds={settings.usageThresholds} onVolumeEjected={async () => { await refreshNow(); }} onUserActionStart={userActions.start} onUserActionComplete={userActions.complete} />;
      case "history.records": return <><SystemEventReplay points={persistentHistory.points} applicationImpactPoints={applicationImpactHistory.points} alerts={resourceAlerts.events} watchEvents={applicationWatchRules.events} networkQualityPoints={networkQuality.history} actions={userActions.records} /><PersonalBaselinePanel points={persistentHistory.points} compact /></>;
      case "history.export": return <HistoryExportPanel sources={{ points: persistentHistory.points, alerts: resourceAlerts.events, networkQualityPoints: networkQuality.history, actions: userActions.records, applicationImpactPoints: applicationImpactHistory.points }} />;
      case "diagnosis.incidents": return <SmartDiagnosis result={activeDiagnosis} expanded={diagnosisExpanded} connectionScanLoading={connectionsLoading && !paused} connectionScanUnavailable={connectionsError !== null} preparingAction={preparingAction} onToggle={() => setDiagnosisExpanded((current) => !current)} onOpenTarget={(view) => { exit(); setActiveView(view); }} onInspectProcess={inspect} onRequestClose={(identity, name) => { exit(); void beginDiagnosisRequestClose(identity, name); }} />;
      case "settings.privacy": return <div className="settings-explorer"><div className="settings-grid"><HistoryRecordingControls settings={settings} onChange={updateSettings} /><PrivacyDataControls settings={settings} dataPrivacy={productDataPrivacy} onClearAllData={clearAllProductData} /></div></div>;
    }
}
