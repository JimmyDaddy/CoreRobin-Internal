/** @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationAvatar } from "./components/ApplicationAvatar";

const iconApi = vi.hoisted(() => ({
  getApplicationIcon: vi.fn(),
}));

vi.mock("./api", () => iconApi);

afterEach(() => cleanup());

beforeEach(() => {
  iconApi.getApplicationIcon.mockReset();
});

describe("application avatar", () => {
  it("loads a real application bundle icon and caches it across surfaces", async () => {
    iconApi.getApplicationIcon.mockResolvedValue({
      mimeType: "image/png",
      bytes: [137, 80, 78, 71],
    });
    const source = { applicationPath: "/Applications/Example Icon.app" } as const;
    const first = render(<ApplicationAvatar name="Example" source={source} />);

    await waitFor(() => expect(first.container.querySelector("img")?.getAttribute("src"))
      .toBe("data:image/png;base64,iVBORw=="));
    expect(iconApi.getApplicationIcon).toHaveBeenCalledWith(source);

    render(<ApplicationAvatar name="Example" source={source} />);
    await waitFor(() => expect(iconApi.getApplicationIcon).toHaveBeenCalledTimes(1));
  });

  it("uses a neutral application fallback when an icon cannot be resolved", async () => {
    iconApi.getApplicationIcon.mockResolvedValue(null);
    const view = render(
      <ApplicationAvatar
        name="微信"
        source={{ applicationPath: "/Applications/No Icon Example.app" }}
      />,
    );

    await waitFor(() => expect(view.container.querySelector(".application-avatar__fallback"))
      .not.toBeNull());
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".application-avatar")?.textContent).toBe("");
  });
});
