import { useEffect, useRef } from "react";

import {
  isDesktopRuntime,
  publishHealthState,
} from "../api";
import type { HealthStateUpdate } from "../healthState";
import { HealthStatePublisher } from "../healthStatePublisher";

export function usePublishHealthState(update: HealthStateUpdate | null): void {
  const publisherRef = useRef<HealthStatePublisher | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const publisher = new HealthStatePublisher(publishHealthState);
    publisherRef.current = publisher;

    return () => {
      if (publisherRef.current === publisher) publisherRef.current = null;
      publisher.dispose();
    };
  }, []);

  useEffect(() => {
    if (update) publisherRef.current?.publish(update);
  }, [update]);
}
