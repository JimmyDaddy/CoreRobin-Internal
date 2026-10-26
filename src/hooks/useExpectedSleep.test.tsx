/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { getMockSnapshot } from "../mockData";
import { useExpectedSleep } from "./useExpectedSleep";

afterEach(cleanup);
it("excludes an intentional assertion from attention while retaining raw evidence, and permits undo", () => {
  const snapshot = getMockSnapshot();
  const process = snapshot.processes[0];
  snapshot.sensors.sleep = { sampledAtMs: 1, available: true, blockers: [{ pid: process.pid, processName: "Encoder", reason: "Rendering", kind: "idle_sleep", durationSeconds: 300 }] };
  const { result } = renderHook(() => useExpectedSleep(snapshot, snapshot, []));
  act(() => result.current.toggle("Encoder"));
  expect(result.current.suppressSleep).toBe(true);
  expect(result.current.guideSnapshot?.sensors.sleep.blockers).toHaveLength(0);
  expect(snapshot.sensors.sleep.blockers).toHaveLength(1);
  act(() => result.current.toggle("Encoder"));
  expect(result.current.guideSnapshot?.sensors.sleep.blockers).toHaveLength(1);
});

it("expires intent on a new process birth or a completed assertion", () => {
  const snapshot = getMockSnapshot();
  const process = snapshot.processes[0];
  snapshot.sensors.sleep = { sampledAtMs: 1, available: true, blockers: [{ pid: process.pid, processName: "Encoder", reason: "Rendering", kind: "idle_sleep", durationSeconds: 300 }] };
  const hook = renderHook(({ value }) => useExpectedSleep(value, value, []), { initialProps: { value: snapshot } });
  act(() => hook.result.current.toggle("Encoder"));
  const restarted = { ...snapshot, processes: snapshot.processes.map((p) => p.pid === process.pid ? { ...p, birthToken: "new-birth", startTime: p.startTime + 1 } : p) };
  hook.rerender({ value: restarted });
  expect(hook.result.current.guideSnapshot?.sensors.sleep.blockers).toHaveLength(1);
  act(() => hook.result.current.toggle("Encoder"));
  hook.rerender({ value: { ...restarted, sensors: { ...restarted.sensors, sleep: { ...restarted.sensors.sleep, blockers: [] } } } });
  hook.rerender({ value: restarted });
  expect(hook.result.current.guideSnapshot?.sensors.sleep.blockers).toHaveLength(1);
});
