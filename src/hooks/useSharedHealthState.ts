import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import {
  getHealthState,
  isDesktopRuntime,
} from "../api";
import {
  HEALTH_STATE_EVENT,
  selectNewerHealthState,
  type HealthStateSnapshot,
} from "../healthState";

export const HEALTH_STATE_RECONNECT_DELAY_MS = 1_000;

export function useSharedHealthState(): HealthStateSnapshot | null {
  const [state, setState] = useState<HealthStateSnapshot | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let retryTimer: number | undefined;
    let connecting = false;
    const accept = (candidate: HealthStateSnapshot | null) => {
      if (!disposed) setState((current) => selectNewerHealthState(current, candidate));
    };
    const scheduleRetry = () => {
      if (disposed || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, HEALTH_STATE_RECONNECT_DELAY_MS);
    };
    const readRetainedState = async () => {
      try {
        accept(await getHealthState());
      } catch {
        scheduleRetry();
      }
    };
    const connect = async () => {
      if (disposed || connecting) return;
      connecting = true;
      try {
        if (!unlisten) {
          const nextUnlisten = await listen<HealthStateSnapshot>(
            HEALTH_STATE_EVENT,
            ({ payload }) => accept(payload),
          );
          if (disposed) {
            nextUnlisten();
            return;
          }
          unlisten = nextUnlisten;
        }

        // Subscribe before reading the retained value so an update cannot
        // fall into the gap between the initial command and registration.
        await readRetainedState();
      } catch {
        // A retained read still gives the surface useful data while event
        // registration is recovering.
        await readRetainedState();
        scheduleRetry();
      } finally {
        connecting = false;
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      unlisten?.();
    };
  }, []);

  return state;
}
