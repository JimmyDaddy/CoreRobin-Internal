import { useEffect, useMemo, useRef, useState } from "react";

import {
  activeDailyIncidents,
  createDailyIncidentEvaluationState,
  evaluateDailyIncidents,
  pendingDailyIncidentCount,
  retainedDailyIncidents,
  type DailyIncidentEvaluationState,
} from "../dailyIncidents";
import type { SmartDiagnosisResult } from "../diagnosis";
import type {
  NetworkConnectionsSnapshot,
  SystemHealthSnapshot,
} from "../types";

export function useDailyIncidents(
  diagnosis: SmartDiagnosisResult | null,
  snapshot: SystemHealthSnapshot | null,
  connections: NetworkConnectionsSnapshot | null,
  suppressSleep = false,
) {
  const stateRef = useRef(createDailyIncidentEvaluationState());
  const [state, setState] = useState<DailyIncidentEvaluationState>(
    stateRef.current,
  );

  useEffect(() => {
    if (!diagnosis || !snapshot) return;
    const current = suppressSleep ? { trackers: Object.fromEntries(Object.entries(stateRef.current.trackers).filter(([id]) => id !== "wellbeing:sleep")) } : stateRef.current;
    const next = evaluateDailyIncidents(current, {
      diagnosis,
      snapshot,
      connections,
    });
    stateRef.current = next;
    setState(next);
  }, [connections, diagnosis, snapshot, suppressSleep]);

  return useMemo(() => ({
    active: activeDailyIncidents(state),
    pendingCount: pendingDailyIncidentCount(state),
    retained: retainedDailyIncidents(state),
  }), [state]);
}
