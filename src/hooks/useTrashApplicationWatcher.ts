import { useCallback, useEffect, useRef, useState } from "react";

import { getTrashedApplications } from "../api";
import type { CommandError, TrashedApplication } from "../types";
import { normalizeCommandError } from "../utils";

const TRASH_APPLICATION_REFRESH_MS = 30_000;

export function useTrashApplicationWatcher(
  enabled: boolean,
  language: string,
) {
  const [applications, setApplications] = useState<TrashedApplication[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return Promise.resolve();
    if (requestRef.current) return requestRef.current;
    const request = getTrashedApplications(language)
      .then((next) => {
        setApplications(next);
        setError(null);
      })
      .catch((reason) => {
        setError(normalizeCommandError(reason));
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
      });
    requestRef.current = request;
    return request;
  }, [enabled, language]);

  useEffect(() => {
    if (!enabled) {
      setApplications([]);
      setError(null);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), TRASH_APPLICATION_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return { applications, error, refresh };
}
