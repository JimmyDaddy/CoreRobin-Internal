/** @vitest-environment jsdom */
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./Select";

afterEach(cleanup);
it("preserves native selection, labels, required validation and refs", () => {
  const ref = createRef<HTMLSelectElement>();
  const onChange = vi.fn();
  render(<label>Scope<Select ref={ref} name="scope" required defaultValue="" onChange={onChange}><option value="">Choose</option><option value="current">Current</option></Select></label>);
  const select = screen.getByRole("combobox", { name: "Scope" });
  expect(ref.current).toBe(select);
  expect(ref.current?.validity.valueMissing).toBe(true);
  fireEvent.change(select, { target: { value: "current" } });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(ref.current?.value).toBe("current");
  expect(ref.current?.validity.valid).toBe(true);
});
it("keeps compact, disabled and invalid presentation without custom listbox behavior", () => {
  render(<Select density="compact" className="caller-class" disabled aria-invalid="true" aria-label="Disabled"><option>One</option></Select>);
  const select = screen.getByRole("combobox") as HTMLSelectElement;
  expect(select.disabled).toBe(true);
  expect(select.classList.contains("ui-select--compact")).toBe(true);
  expect(select.classList.contains("caller-class")).toBe(true);
  expect(select.getAttribute("aria-invalid")).toBe("true");
});
