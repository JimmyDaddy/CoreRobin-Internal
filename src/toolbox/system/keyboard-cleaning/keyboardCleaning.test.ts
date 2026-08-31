import { describe, expect, it } from "vitest";

import {
  HARD_LIMIT_MS,
  HEARTBEAT_GRACE_MS,
  KEYBOARD_CLEANING_PROTOCOL_VERSION,
  KeyboardCleaningMachine,
  PREPARATION_WINDOW_MS,
  type KeyboardCleaningCapability,
} from "./keyboardCleaning";

const available: KeyboardCleaningCapability = { state: "available", platform: "macos", reason: null };
const unavailable: KeyboardCleaningCapability = { state: "unavailable", platform: "unknown", reason: "平台未提供经过验证的安全 hook。" };

function start(machine: KeyboardCleaningMachine, nowMs = 0) {
  return machine.dispatch({ type: "start", requestId: "request-1", durationSeconds: 30, nowMs });
}

function confirm(machine: KeyboardCleaningMachine, nowMs = 1_000) {
  return machine.applySignal({ type: "ready", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId: "request-1", capability: "available", effectiveness: "confirmed" } }, nowMs);
}

describe("keyboard cleaning safety state machine", () => {
  it("keeps unavailable platforms conservative", () => {
    const machine = new KeyboardCleaningMachine(unavailable);
    expect(machine.snapshot().status).toBe("unavailable");
    expect(() => start(machine)).toThrow(/未提供经过验证的安全 hook/);
  });

  it("requires three seconds of preparation and explicit hook confirmation", () => {
    const machine = new KeyboardCleaningMachine(available);
    expect(start(machine).state.status).toBe("preparing");
    confirm(machine, PREPARATION_WINDOW_MS - 1);
    expect(machine.snapshot().status).toBe("preparing");
    expect(machine.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS }).state.status).toBe("active");
  });

  it("never reports unconfirmed, silently ineffective, or late hooks as active", () => {
    const machine = new KeyboardCleaningMachine(available);
    start(machine);
    expect(machine.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS }).state.status).toBe("releasing");

    const ineffective = new KeyboardCleaningMachine(available);
    start(ineffective);
    expect(ineffective.applySignal({ type: "ready", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId: "request-1", capability: "available", effectiveness: "silently_ineffective" } }, 1_000).state.status).toBe("releasing");

    const late = new KeyboardCleaningMachine(available);
    start(late);
    late.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS });
    expect(confirm(late, PREPARATION_WINDOW_MS + 1).state.status).toBe("releasing");
  });

  it("releases on mouse, focus, host, sleep, permission, and heartbeat loss", () => {
    for (const type of ["mouse_activity", "focus_lost", "host_exited", "sleeping", "permission_revoked"] as const) {
      const machine = new KeyboardCleaningMachine(available);
      start(machine);
      confirm(machine);
      machine.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS });
      expect(machine.dispatch({ type, nowMs: PREPARATION_WINDOW_MS + 1 }).state.status).toBe("releasing");
    }

    const heartbeat = new KeyboardCleaningMachine(available);
    start(heartbeat);
    confirm(heartbeat);
    heartbeat.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS });
    heartbeat.applySignal({ type: "heartbeat", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId: "request-1", sequence: 1 } }, PREPARATION_WINDOW_MS + 1);
    expect(heartbeat.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS + 1 + HEARTBEAT_GRACE_MS }).state.status).toBe("releasing");
  });

  it("enforces selectable duration and the independent hard ceiling", () => {
    for (const duration of [30, 60, 120] as const) {
      const machine = new KeyboardCleaningMachine(available);
      const result = machine.dispatch({ type: "start", requestId: `request-${duration}`, durationSeconds: duration, nowMs: 0 });
      expect(result.state.hardDeadlineMs).toBe(HARD_LIMIT_MS);
      expect(result.state.activeDeadlineMs).toBe(PREPARATION_WINDOW_MS + duration * 1_000);
    }
    expect(() => new KeyboardCleaningMachine(available).dispatch({ type: "start", requestId: "request-1", durationSeconds: 181, nowMs: 0 })).toThrow(/30、60 或 120/);
  });

  it("applies the hard deadline even when the selected duration is longer in the future", () => {
    const machine = new KeyboardCleaningMachine(available);
    machine.dispatch({ type: "start", requestId: "request-1", durationSeconds: 120, nowMs: 0 });
    confirm(machine);
    machine.dispatch({ type: "tick", nowMs: PREPARATION_WINDOW_MS });
    const transition = machine.dispatch({ type: "tick", nowMs: HARD_LIMIT_MS });
    expect(transition.state.status).toBe("releasing");
    expect(transition.state.endReason).toBe("hard_deadline");
  });

  it("only exposes lifecycle facts in helper frames", () => {
    const machine = new KeyboardCleaningMachine(available);
    const frame = JSON.stringify(start(machine).effects[0]);
    expect(frame).not.toMatch(/"(?:key|text|scan|clipboard|input)"/i);
  });
});
