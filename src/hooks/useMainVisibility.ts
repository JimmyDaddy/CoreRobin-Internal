import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { isDesktopRuntime } from "../api";

export const MAIN_VISIBILITY_EVENT = "core-robin:main-visibility";

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function useMainVisibility(): boolean {
  // The desktop window starts behind the splash screen. Treat it as visible
  // until the backend explicitly reports a user-initiated hide so startup can
  // obtain the first full snapshot.
  const [backendVisible, setBackendVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(documentIsVisible);

  useEffect(() => {
    const handleVisibilityChange = () => setDocumentVisible(documentIsVisible());
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<boolean>(MAIN_VISIBILITY_EVENT, ({ payload }) => {
      if (!disposed) setBackendVisible(Boolean(payload));
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return backendVisible && documentVisible;
}
