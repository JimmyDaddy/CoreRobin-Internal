/** @vitest-environment jsdom */

import { StrictMode, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAsyncListenerRegistry,
  type Unlisten,
} from "./asyncListener";

afterEach(cleanup);

describe("async listener lifecycle", () => {
  it("unregisters a listener that resolves after disposal", async () => {
    const registry = createAsyncListenerRegistry();
    const deferred = createDeferred<Unlisten>();
    const unlisten = vi.fn();

    registry.register(deferred.promise);
    registry.dispose();
    deferred.resolve(unlisten);
    await deferred.promise;
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("returns to the listener baseline after StrictMode double mounting", async () => {
    const unlisteners: ReturnType<typeof vi.fn>[] = [];
    const register = () => {
      const unlisten = vi.fn();
      unlisteners.push(unlisten);
      return Promise.resolve(unlisten);
    };

    const view = render(
      <StrictMode>
        <ListenerHarness register={register} />
      </StrictMode>,
    );
    await act(() => Promise.resolve());
    view.unmount();

    expect(unlisteners).toHaveLength(2);
    expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("cleans up every registration across repeated HMR-style remounts", async () => {
    const unlisteners: ReturnType<typeof vi.fn>[] = [];
    const createRegistration = () => () => {
      const unlisten = vi.fn();
      unlisteners.push(unlisten);
      return Promise.resolve(unlisten);
    };
    const view = render(<ListenerHarness register={createRegistration()} />);

    for (let index = 0; index < 20; index += 1) {
      view.rerender(<ListenerHarness register={createRegistration()} />);
      await act(() => Promise.resolve());
    }
    view.unmount();

    expect(unlisteners).toHaveLength(21);
    expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });
});

function ListenerHarness({ register }: { register: () => Promise<Unlisten> }) {
  useEffect(() => {
    const registry = createAsyncListenerRegistry();
    registry.register(register());
    return () => registry.dispose();
  }, [register]);
  return null;
}

function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
