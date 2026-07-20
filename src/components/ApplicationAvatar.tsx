import { AppWindow } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getApplicationIcon } from "../api";
import type { ApplicationIconRequest } from "../types";

const MAX_CACHED_ICONS = 128;
const MAX_CONCURRENT_ICON_LOADS = 4;
const iconRequests = new Map<string, Promise<string | null>>();
const queuedIconLoads: Array<() => void> = [];
let activeIconLoads = 0;

export function ApplicationAvatar({
  name,
  source,
  className = "",
}: {
  name: string;
  source: ApplicationIconRequest | null;
  className?: string;
}) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const requestKey = iconRequestKey(source);
  const [shouldLoad, setShouldLoad] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [iconUrl, setIconUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (shouldLoad || requestKey === "fallback") return;
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [requestKey, shouldLoad]);

  useEffect(() => {
    let cancelled = false;
    setIconUrl(undefined);
    const request = sourceRef.current;
    if (!request) {
      setIconUrl(null);
      return;
    }
    if (!shouldLoad) return;
    void loadApplicationIcon(request).then((url) => {
      if (!cancelled) setIconUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, shouldLoad]);

  const loading = source !== null && iconUrl === undefined;
  return (
    <span
      ref={elementRef}
      className={`application-avatar${loading ? " is-loading" : ""}${iconUrl ? " has-icon" : ""}${className ? ` ${className}` : ""}`}
      title={name}
      aria-hidden="true"
    >
      {iconUrl
        ? <img src={iconUrl} alt="" draggable={false} />
        : loading
          ? <span className="application-avatar__shimmer" />
          : <AppWindow className="application-avatar__fallback" size={18} />}
    </span>
  );
}

function loadApplicationIcon(request: ApplicationIconRequest): Promise<string | null> {
  const key = iconRequestKey(request);
  const cached = iconRequests.get(key);
  if (cached) {
    iconRequests.delete(key);
    iconRequests.set(key, cached);
    return cached;
  }
  const pending = enqueueIconLoad(() => getApplicationIcon(request))
    .then((icon) => {
      if (!icon || icon.mimeType !== "image/png" || icon.bytes.length === 0) return null;
      return pngDataUrl(icon.bytes, icon.mimeType);
    })
    .catch(() => null);
  iconRequests.set(key, pending);
  while (iconRequests.size > MAX_CACHED_ICONS) {
    const oldestKey = iconRequests.keys().next().value;
    if (oldestKey === undefined) break;
    iconRequests.delete(oldestKey);
  }
  return pending;
}

function enqueueIconLoad<T>(load: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queuedIconLoads.push(() => {
      activeIconLoads += 1;
      void Promise.resolve().then(load).then(resolve, reject).finally(() => {
        activeIconLoads -= 1;
        startQueuedIconLoads();
      });
    });
    startQueuedIconLoads();
  });
}

function startQueuedIconLoads() {
  while (activeIconLoads < MAX_CONCURRENT_ICON_LOADS) {
    const next = queuedIconLoads.shift();
    if (!next) return;
    next();
  }
}

function pngDataUrl(bytes: number[], mimeType: string): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 32_768) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 32_768));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function iconRequestKey(request: ApplicationIconRequest | null): string {
  if (!request) return "fallback";
  if (request.applicationPath) return `bundle:${request.applicationPath}`;
  if (request.executablePath) return `executable:${request.executablePath}`;
  const process = request.process;
  if (!process) return "fallback";
  return `process:${process.pid}:${process.snapshotBirthToken ?? `fallback:${process.snapshotStartTime}`}`;
}
