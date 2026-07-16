/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("uses the shared base style and a safe button default", () => {
    render(<Button variant="primary">检查一下</Button>);

    const button = screen.getByRole("button", { name: "检查一下" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.classList.contains("button")).toBe(true);
    expect(button.classList.contains("button--primary")).toBe(true);
  });

  it("keeps custom classes and native button attributes", () => {
    render(<Button className="toolbar-action" disabled>更新</Button>);

    const button = screen.getByRole("button", { name: "更新" }) as HTMLButtonElement;
    expect(button.classList.contains("button")).toBe(true);
    expect(button.classList.contains("button--plain")).toBe(true);
    expect(button.classList.contains("toolbar-action")).toBe(true);
    expect(button.disabled).toBe(true);
  });
});
