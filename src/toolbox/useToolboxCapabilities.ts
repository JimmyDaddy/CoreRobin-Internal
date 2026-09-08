import { useEffect, useState } from "react";
import { isDesktopRuntime } from "../api";
import { getToolboxSnapshot, selectNewerToolboxSnapshot, subscribeToolboxEvents } from "./client";
import type { ToolId, ToolboxCapability, ToolboxSnapshot } from "./contracts";
import { clearSharedToolState } from "./local/sharedToolState";

export function useToolboxCapabilities() {
  const [nativeCapabilities, setNativeCapabilities] = useState<Partial<Record<ToolId, ToolboxCapability>>>();
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;
    let currentSnapshot: ToolboxSnapshot | null = null;
    let initialSnapshotRead = false;
    const pendingSnapshots: ToolboxSnapshot[] = [];
    const applySnapshot = (candidate: ToolboxSnapshot) => {
      const nextSnapshot = selectNewerToolboxSnapshot(currentSnapshot, candidate);
      if (!mounted || nextSnapshot === null || nextSnapshot === currentSnapshot) return;
      if (currentSnapshot && nextSnapshot.resetEpoch > currentSnapshot.resetEpoch) clearSharedToolState();
      currentSnapshot = nextSnapshot;
      setNativeCapabilities(nextSnapshot.capabilities);
    };
    const acceptEventSnapshot = (candidate: ToolboxSnapshot) => {
      if (!initialSnapshotRead) {
        pendingSnapshots.push(candidate);
        return;
      }
      applySnapshot(candidate);
    };
    void (async () => {
      try {
        const nextUnlisten = await subscribeToolboxEvents((event) => {
          if (event.type === "snapshot") acceptEventSnapshot(event.snapshot);
        });
        if (!mounted) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;

        // Register first so an update cannot fall between the retained read
        // and the event listener. The retained snapshot is the initial
        // service-instance baseline; events received before it are replayed
        // only after that baseline establishes the valid revision sequence.
        try {
          applySnapshot(await getToolboxSnapshot());
        } catch {
          // Browser-local tools remain available when the native snapshot is unavailable.
        } finally {
          initialSnapshotRead = true;
          for (const snapshot of pendingSnapshots.splice(0)) applySnapshot(snapshot);
        }
      } catch {
        // Browser-local tools remain available when event registration is unavailable.
      }
    })();
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);
  return nativeCapabilities;
}
