import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";

import "./i18n";
import i18n from "./i18n";
import "./styles/feature-intelligence.css";
import "./App.css";
import "./styles/product-support.css";
import "./visualRegression.css";
import { Button } from "./components/Button";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import { TodayReview } from "./components/TodayReview";
import { WeeklyReview } from "./components/WeeklyReview";
import { HistoryExportPanel } from "./components/HistoryExportPanel";
import "./components/HistoryExplorer.css";
import type { HistoryPoint } from "./types";
import type { UserActionRecord } from "./userActionHistory";

document.documentElement.dataset.surface = "main";
document.body.dataset.surface = "main";

function VisualRegressionHarness() {
  const query = new URLSearchParams(window.location.search);
  const language = query.get("language") || "en";
  const scenario = query.get("scenario") || "states";
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void i18n.changeLanguage(language).then(() => setReady(true));
  }, [language]);

  if (!ready) return null;
  if (scenario === "review") return <ReviewScenario />;
  if (scenario === "export") return <ExportScenario />;
  return <StateScenario />;
}

function StateScenario() {
  const now = Date.now();
  const points = [
    chartPoint(now - 60 * 60_000, 18, 32),
    chartPoint(now - 55 * 60_000, 28, 36),
    chartPoint(now - 50 * 60_000, 96, 73),
    chartPoint(now - 20 * 60_000, 26, 39),
    chartPoint(now - 15 * 60_000, 42, 44),
    chartPoint(now - 10 * 60_000, 31, 40),
  ];
  return (
    <main className="visual-harness">
      <header>
        <small>CoreRobin · visual states</small>
        <h1>Loading, disabled, error, complete, long text and data gaps</h1>
      </header>
      <section className="visual-harness__buttons panel">
        <Button variant="primary">
          <LoaderCircle className="is-spinning" size={15} />Checking for updates…
        </Button>
        <Button variant="secondary" disabled>
          <LoaderCircle className="is-spinning" size={15} />Installing update…
        </Button>
        <Button variant="danger">
          <AlertTriangle size={15} />Retry failed operation
        </Button>
        <Button variant="plain">
          <CheckCircle2 size={15} />Completed successfully
        </Button>
      </section>
      <section className="visual-harness__states">
        <article className="panel is-loading">
          <LoaderCircle className="is-spinning" size={22} />
          <strong>Scanning a large folder</strong>
          <span>Progress remains readable while the task is in the background.</span>
        </article>
        <article className="panel is-error">
          <AlertTriangle size={22} />
          <strong>The current operation needs attention</strong>
          <span>A deliberately long recovery explanation must wrap without moving the action outside the card.</span>
        </article>
        <article className="panel is-empty">
          <CheckCircle2 size={22} />
          <strong>No results yet</strong>
          <span>Empty states keep a clear next action instead of leaving unused space.</span>
        </article>
      </section>
      <section className="panel visual-harness__chart">
        <h2>Extreme peak and interrupted sampling</h2>
        <TimeSeriesChart
          ariaLabel="Visual regression time series"
          completenessLabel={(percent) => `${percent}% data coverage`}
          earlierLabel="1 hour ago"
          endAtMs={now}
          expectedIntervalMs={5 * 60_000}
          gapThresholdMs={12 * 60_000}
          language="en"
          maximum={100}
          nowLabel="Now"
          points={points}
          series={[
            { label: "CPU", color: "var(--chart-cpu)", format: (value) => `${value.toFixed(0)}%` },
            { label: "Memory", color: "var(--chart-memory)", dashed: true, format: (value) => `${value.toFixed(0)}%` },
          ]}
          startAtMs={now - 60 * 60_000}
        />
      </section>
    </main>
  );
}

function ReviewScenario() {
  const now = Date.now();
  const completedAtMs = now - 20 * 60_000;
  const points = [
    historyPoint(completedAtMs - 10 * 60_000, 74, 71),
    historyPoint(completedAtMs - 5 * 60_000, 68, 69),
    historyPoint(completedAtMs + 5 * 60_000, 31, 55),
    historyPoint(completedAtMs + 10 * 60_000, 24, 51),
  ];
  const actions: UserActionRecord[] = [
    action("process_close", completedAtMs, {
      targetName: "A deliberately long application name that verifies wrapping",
      outcome: { processExited: true, succeededCount: 1 },
    }),
    action("cleanup_delete", completedAtMs - 30 * 60_000, {
      targetName: "Downloads",
      targetCount: 18,
      affectedBytes: 4_294_967_296,
      outcome: {
        selectedCount: 18,
        succeededCount: 15,
        skippedCount: 3,
        releasedBytes: 4_294_967_296,
      },
    }),
  ];
  return (
    <main className="visual-harness">
      <TodayReview
        points={points}
        applicationImpactPoints={[]}
        alertEvents={[]}
        networkQualityPoints={[]}
        actionRecords={actions}
        onOpenAction={() => undefined}
      />
      <WeeklyReview
        points={points}
        alerts={[]}
        networkQualityPoints={[]}
        actions={actions}
        notificationEnabled={false}
        notificationsAvailable={false}
        onNotificationEnabledChange={() => undefined}
      />
    </main>
  );
}

function ExportScenario() {
  const now = Date.now();
  const points = [
    historyPoint(now - 90 * 60_000, 33, 58),
    historyPoint(now - 30 * 60_000, 45, 62),
  ];
  return (
    <main className="visual-harness">
      <HistoryExportPanel
        sources={{
          points,
          alerts: [],
          networkQualityPoints: [],
          actions: [
            action("cleanup_delete", now - 20 * 60_000, {
              targetName: "Downloads",
              affectedBytes: 1_073_741_824,
            }),
          ],
          applicationImpactPoints: [],
        }}
      />
    </main>
  );
}

function chartPoint(
  timestamp: number,
  first: number,
  second: number,
) {
  return { timestamp, values: [first, second] };
}

function historyPoint(
  timestamp: number,
  cpuPercent: number,
  memoryPercent: number,
): HistoryPoint {
  return {
    timestamp,
    cpuPercent,
    memoryPercent,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
  };
}

function action(
  kind: UserActionRecord["kind"],
  completedAtMs: number,
  overrides: Partial<UserActionRecord>,
): UserActionRecord {
  return {
    id: `${kind}-${completedAtMs}`,
    kind,
    status: "succeeded",
    verification: "verified",
    startedAtMs: completedAtMs - 1_000,
    completedAtMs,
    targetName: null,
    targetCount: 1,
    affectedBytes: null,
    failedCount: 0,
    ...overrides,
  };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <VisualRegressionHarness />
  </React.StrictMode>,
);
