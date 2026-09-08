import { useCallback, useEffect, useRef, useState } from "react";
import { readApplicationCapabilities, type ApplicationCapabilityState } from "./api";
import { useCapabilityChanges } from "./useCapabilityChanges";

export function useApplicationCapabilities() {
  const [state, setState] = useState<ApplicationCapabilityState | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const next = await readApplicationCapabilities();
    if (mounted.current) setState((current) => current && (next.diskRevision < current.diskRevision || next.networkRevision < current.networkRevision) ? current : next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    return () => { mounted.current = false; };
  }, [refresh]);
  useCapabilityChanges("disk", refresh);
  useCapabilityChanges("network", refresh);
  return state;
}
