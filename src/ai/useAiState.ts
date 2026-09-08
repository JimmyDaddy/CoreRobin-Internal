import { useCallback, useEffect, useRef, useState } from "react";
import { aiApi } from "./api";
import { aiError, type AiError, type AiState } from "./types";

export function useAiState() {
  const [state, setState] = useState<AiState | null>(null);
  const [error, setError] = useState<AiError | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await aiApi.getState();
      if (request === sequence.current) {
        setState(result);
        setError(null);
      }
      return result;
    } catch (failure) {
      if (request === sequence.current) setError(aiError(failure));
      throw failure;
    }
  }, []);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const changed = () => {
      if (!closed && timer === undefined)
        timer = setTimeout(() => {
          timer = undefined;
          if (!closed) void refresh().catch(() => {});
        }, 80);
    };
    void aiApi
      .onChange(changed)
      .then((stop) => {
        if (closed) stop();
        else {
          unlisten = stop;
          void refresh().catch(() => {});
        }
      })
      .catch((failure) => {
        if (!closed) setError(aiError(failure));
      });
    void refresh().catch(() => {});
    return () => {
      closed = true;
      ++sequence.current;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [refresh]);
  return { state, error, refresh };
}
