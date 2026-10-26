import { useCallback, useEffect, useMemo, useState } from "react";
import { summarizeSleepBlockers } from "../deviceWellbeing";
import type { ApplicationImpact } from "../diagnosis";
import type { ProcessRow, SleepBlocker, SleepSnapshot, SystemHealthSnapshot, SystemSnapshot } from "../types";
import { processIdentity } from "../utils";

export function sleepExpectationKey(blocker: SleepBlocker, processes: readonly ProcessRow[]) {
  const process = processes.find(({ pid }) => pid === blocker.pid);
  return JSON.stringify([process ? processIdentity(process) : blocker.pid, blocker.processName, blocker.kind, blocker.reason]);
}

export function withoutExpectedSleep(sleep: SleepSnapshot, processes: readonly ProcessRow[], expected: ReadonlySet<string>): SleepSnapshot {
  if (expected.size === 0) return sleep;
  return { ...sleep, blockers: sleep.blockers.filter((blocker) => !expected.has(sleepExpectationKey(blocker, processes))) };
}

// Session-only intent, tied to the current process birth and assertion. It
// expires when the task disappears and never changes the raw sensor evidence.
export function useExpectedSleep(snapshot: SystemSnapshot | null, health: SystemHealthSnapshot | null, applications: readonly ApplicationImpact[]) {
  const [expected, setExpected] = useState<Set<string>>(new Set());
  const processes = snapshot?.processes ?? health?.processes ?? [];
  const rawSleep = health?.sensors.sleep ?? snapshot?.sensors.sleep;
  useEffect(() => {
    if (!rawSleep?.available) return;
    const live = new Set(rawSleep.blockers.map((blocker) => sleepExpectationKey(blocker, processes)));
    setExpected((current) => [...current].every((key) => live.has(key)) ? current : new Set([...current].filter((key) => live.has(key))));
  }, [processes, rawSleep]);
  const toggle = useCallback((name: string) => {
    if (!rawSleep) return;
    const keys = rawSleep.blockers.filter((blocker) => {
      const summary = summarizeSleepBlockers({ ...rawSleep, blockers: [blocker] }, applications)[0];
      return summary?.name === name && !summary.systemComponent;
    }).map((blocker) => sleepExpectationKey(blocker, processes));
    setExpected((current) => {
      const remove = keys.every((key) => current.has(key));
      const next = new Set(current);
      keys.forEach((key) => { if (remove) next.delete(key); else next.add(key); });
      return next;
    });
  }, [applications, processes, rawSleep]);
  return useMemo(() => {
    const filteredSleep = rawSleep ? withoutExpectedSleep(rawSleep, processes, expected) : undefined;
    const remaining = new Set(filteredSleep ? summarizeSleepBlockers(filteredSleep, applications).map(({ name }) => name) : []);
    const expectedNames = new Set(rawSleep ? summarizeSleepBlockers(rawSleep, applications).filter(({ name, systemComponent }) => !systemComponent && !remaining.has(name)).map(({ name }) => name) : []);
    return {
      toggle, expectedNames,
      health: health && filteredSleep ? { ...health, sensors: { ...health.sensors, sleep: filteredSleep } } : health,
      guideSnapshot: snapshot && filteredSleep ? { ...snapshot, sensors: { ...snapshot.sensors, sleep: filteredSleep } } : snapshot,
      suppressSleep: expectedNames.size > 0 && filteredSleep !== undefined && summarizeSleepBlockers(filteredSleep, applications).every(({ systemComponent }) => systemComponent),
    };
  }, [applications, expected, health, processes, rawSleep, snapshot, toggle]);
}
