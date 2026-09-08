/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { SourceDataClearAction } from "./SourceDataClearAction";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

describe("source data removal consent", () => {
  it("keeps confirmation inside a modal operation and Escape restores focus without closing the operation", () => {
    const clear = vi.fn();
    const outerKey = vi.fn();
    render(<dialog open onKeyDown={outerKey}><SourceDataClearAction label="Clear saved samples" onClear={clear} /></dialog>);
    const trigger = screen.getByRole("button", { name: "Clear saved samples" });
    trigger.focus();
    fireEvent.click(trigger);
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation.closest("dialog")).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    expect(outerKey).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
  it("explains retained copies and forwards explicit related-conversation deletion", async () => {
    const clear = vi.fn(async () => true);
    render(<SourceDataClearAction label="Clear saved samples" onClear={clear} />);
    fireEvent.click(screen.getByRole("button", {name: "Clear saved samples"}));
    expect(clear).not.toHaveBeenCalled();
    expect(screen.getByText("Saved AI conversations may still contain copies of this data.")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await act(async () => fireEvent.click(screen.getByRole("button", {name: "Clear category"})));
    expect(clear).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not imply successful removal when a source operation fails", async () => {
    const clear = vi.fn(async () => false);
    render(<SourceDataClearAction label="Clear saved samples" onClear={clear} />);
    fireEvent.click(screen.getByRole("button", {name: "Clear saved samples"}));
    await act(async () => fireEvent.click(screen.getByRole("button", {name: "Clear category"})));
    expect(clear).toHaveBeenCalledWith(false);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
