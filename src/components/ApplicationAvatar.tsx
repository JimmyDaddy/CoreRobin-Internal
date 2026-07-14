import { useEffect, useState, type CSSProperties } from "react";

import { getApplicationIcon } from "../api";
import type { ApplicationImpact } from "../diagnosis";
import type { ProcessDetailRequest } from "../types";

const MAX_CACHED_ICONS = 96;
const iconRequests = new Map<string, Promise<string | null>>();

export function ApplicationAvatar({
  application,
  className = "",
}: {
  application: Pick<ApplicationImpact, "name" | "iconProcess">;
  className?: string;
}) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const requestKey = iconRequestKey(application.iconProcess);

  useEffect(() => {
    let cancelled = false;
    void loadApplicationIcon(application.iconProcess).then((url) => {
      if (!cancelled) setIconUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  return (
    <span
      className={`application-avatar${className ? ` ${className}` : ""}`}
      style={{ "--application-hue": applicationHue(application.name) } as CSSProperties}
      aria-hidden="true"
    >
      {iconUrl
        ? <img src={iconUrl} alt="" />
        : applicationInitial(application.name)}
    </span>
  );
}

function loadApplicationIcon(request: ProcessDetailRequest): Promise<string | null> {
  const key = iconRequestKey(request);
  const cached = iconRequests.get(key);
  if (cached) {
    iconRequests.delete(key);
    iconRequests.set(key, cached);
    return cached;
  }
  const pending = getApplicationIcon(request)
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

function pngDataUrl(bytes: number[], mimeType: string): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 32_768) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 32_768));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function iconRequestKey(request: ProcessDetailRequest): string {
  return `${request.pid}:${request.snapshotBirthToken ?? `fallback:${request.snapshotStartTime}`}`;
}

function applicationInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
}

function applicationHue(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}
