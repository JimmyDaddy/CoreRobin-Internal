import { useEffect, useState } from "react";

import {
  type SelectedProcessHistory,
  updateSelectedProcessHistory,
} from "../processExplorer";
import type { SystemSnapshot } from "../types";

export function useSelectedProcessHistory(
  snapshot: SystemSnapshot | null,
  selectedIdentity: string | null,
): SelectedProcessHistory | null {
  const [history, setHistory] = useState<SelectedProcessHistory | null>(null);

  useEffect(() => {
    setHistory((current) =>
      updateSelectedProcessHistory(current, snapshot, selectedIdentity),
    );
  }, [selectedIdentity, snapshot?.sequence]);

  return history?.identity === selectedIdentity ? history : null;
}
