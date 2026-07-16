/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SmartDiagnosis } from "./components/SmartDiagnosis";
import type { DiagnosisStatus, SmartDiagnosisResult } from "./diagnosis";
import i18n from "./i18n";

afterEach(() => cleanup());
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

describe("professional overview Robin", () => {
  it("reflects diagnosis state and scanning activity", () => {
    const view = renderDiagnosis("healthy");
    let robin = view.container.querySelector(".smart-diagnosis__robin .animated-robin");

    expect(screen.getByRole("heading", { name: "目前运行正常" })).toBeTruthy();
    expect(robin?.getAttribute("data-mood")).toBe("normal");
    expect(robin?.getAttribute("data-active")).toBe("false");

    view.rerender(diagnosisElement("observing", true));
    robin = view.container.querySelector(".smart-diagnosis__robin .animated-robin");
    expect(robin?.getAttribute("data-mood")).toBe("observing");
    expect(robin?.getAttribute("data-active")).toBe("true");
  });
});

function renderDiagnosis(status: DiagnosisStatus) {
  return render(diagnosisElement(status, false));
}

function diagnosisElement(status: DiagnosisStatus, connectionScanLoading: boolean) {
  return (
    <SmartDiagnosis
      result={diagnosisResult(status)}
      expanded={false}
      connectionScanLoading={connectionScanLoading}
      connectionScanUnavailable={false}
      preparingAction={false}
      onToggle={() => undefined}
      onOpenTarget={() => undefined}
      onInspectProcess={() => undefined}
      onRequestClose={() => undefined}
    />
  );
}

function diagnosisResult(status: DiagnosisStatus): SmartDiagnosisResult {
  return {
    analyzedAtMs: 1_000,
    status,
    findings: [],
    applications: [],
    baselineReady: status !== "observing",
    sampleSpanMs: status === "observing" ? 2_000 : 10_000,
    checkedCategories: ["cpu", "memory", "storage", "disk_io", "network"],
  };
}
