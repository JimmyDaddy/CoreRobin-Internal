export type Unlisten = () => void;

export interface AsyncListenerRegistry {
  readonly disposed: boolean;
  register(registration: Promise<Unlisten>): void;
  dispose(): void;
}

export function createAsyncListenerRegistry(): AsyncListenerRegistry {
  let disposed = false;
  const active = new Set<Unlisten>();

  return {
    get disposed() {
      return disposed;
    },
    register(registration) {
      void registration
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          active.add(unlisten);
        })
        .catch(() => {
          // A failed registration has nothing to clean up.
        });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unlisten of active) {
        try {
          unlisten();
        } catch {
          // Continue releasing the remaining listeners.
        }
      }
      active.clear();
    },
  };
}
