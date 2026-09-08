import { useEffect, useRef } from "react";
import { createAsyncListenerRegistry } from "../asyncListener";
import { subscribeApplicationCapabilities, type ApplicationCapability } from "./api";

/** Events only invalidate. The callback rereads native data; no payload is authority. */
export function useCapabilityChanges(capability: ApplicationCapability, refresh: () => Promise<unknown>) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const listeners = createAsyncListenerRegistry();
    const reload = () => { if (!listeners.disposed) void latest.current().catch(() => {}); };
    listeners.register(subscribeApplicationCapabilities((changed) => {
      if (changed === capability) reload();
    }));
    const visible = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    // Bounded recovery for a lost wakeup or failed listener, including two
    // surfaces that remain visible throughout a background native operation.
    const timer = window.setInterval(visible, 30_000);
    return () => {
      listeners.dispose();
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [capability]);
}
