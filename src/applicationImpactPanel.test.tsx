/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationImpactPanel } from "./components/ApplicationImpactPanel";
import type { ApplicationImpact } from "./diagnosis";

vi.mock("./components/ApplicationAvatar", () => ({ ApplicationAvatar: () => null }));
vi.mock("./i18n/useAppTranslation", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it("renders only the current application page and holds its order until explicitly reordered", () => {
  const applications: ApplicationImpact[] = Array.from({ length: 500 }, (_, index) => ({
    id: String(index), name: `App ${index}`, kind: "user", processCount: 1,
    cpuPercent: 500 - index, memoryBytes: 0, diskBytesPerSecond: 0,
    systemComponent: false, representativeIdentity: String(index), actionIdentity: null,
    memberIdentities: [String(index)], iconProcess: { pid: index + 1, snapshotStartTime: 1, snapshotBirthToken: null },
  }));
  const props = { totalMemoryBytes: 1024, selectedIdentity: null, onSelect: vi.fn() };
  const view = render(<ApplicationImpactPanel {...props} applications={applications} />);
  expect(screen.getAllByRole("button", { name: /^App / })).toHaveLength(24);
  expect(screen.getAllByRole("button", { name: /^App / })[0].textContent).toContain("App 0");
  view.rerender(<ApplicationImpactPanel {...props} applications={applications.map((application, index) => ({ ...application, cpuPercent: index }))} />);
  expect(screen.getAllByRole("button", { name: /^App / })[0].textContent).toContain("App 0");
  fireEvent.click(screen.getByText("applications:experience.reorder"));
  expect(screen.getAllByRole("button", { name: /^App / })[0].textContent).toContain("App 499");
  fireEvent.click(screen.getByText("applications:experience.next"));
  expect(screen.getAllByRole("button", { name: /^App / })).toHaveLength(24);
  expect(screen.getAllByRole("button", { name: /^App / })[0].textContent).toContain("App 475");
});
