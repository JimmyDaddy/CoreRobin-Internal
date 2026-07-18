import { describe, expect, it } from "vitest";

import { aggregateConnectionHistory, mergeConnectionHistory } from "./connectionHistory";
import type { NetworkConnectionsSnapshot, ProcessRow } from "./types";

describe("connection history", () => {
  it("groups snapshots by application and resolved hostname", () => {
    const snapshot: NetworkConnectionsSnapshot = {
      sampledAtMs: 600_000,
      summary: { totalCount: 1, tcpCount: 1, udpCount: 0, establishedCount: 1, listeningCount: 0, attributedCount: 1 },
      connections: [{
        protocol: "tcp",
        addressFamily: "ipv4",
        localEndpoint: { address: "127.0.0.1", port: 12_000 },
        remoteEndpoint: { address: "1.1.1.1", port: 443 },
        state: "established",
        associatedPids: [42],
      }],
      processAttribution: "available",
      truncated: false,
      skippedEntryCount: 0,
    };
    const process = { pid: 42, name: "Browser" } as ProcessRow;
    const entries = mergeConnectionHistory([], snapshot, [process], [
      { address: "1.1.1.1", hostname: "one.one.one.one" },
    ], 30, 600_000);

    expect(aggregateConnectionHistory(entries, "application")[0].label).toBe("Browser");
    expect(aggregateConnectionHistory(entries, "domain")[0].label).toBe("one.one.one.one");
  });
});
