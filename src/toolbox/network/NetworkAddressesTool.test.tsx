/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { NetworkAddressesTool } from "./NetworkAddressesTool";
import { ToolboxInputError } from "../local/toolboxErrors";
import type { NetworkAddressesSnapshot } from "./networkTools";
import i18n from "../../i18n";

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

it("loads a fresh snapshot and only writes network identifiers after an explicit copy click", async () => {
  const snapshot: NetworkAddressesSnapshot = {
    sampledAtMs: Date.UTC(2026, 7, 31, 15, 0),
    interfaces: [{
      name: "en0",
      mtu: 1500,
      macAddress: "aa:bb:cc:dd:ee:ff",
      ipNetworks: ["192.168.1.5/24", "fe80::1/64"],
      operationalState: "up",
    }],
  };
  const loadSnapshot = vi.fn(async () => snapshot);

  render(<NetworkAddressesTool loadSnapshot={loadSnapshot} />);
  expect(loadSnapshot).toHaveBeenCalledOnce();
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  expect(await screen.findByText("en0")).toBeTruthy();
  expect(screen.getByText(/采样时间：/)).toBeTruthy();
  expect(screen.getByText("1 个接口")).toBeTruthy();
  expect(screen.getByText(/IP、IPv6 zone、MAC/)).toBeTruthy();
  expect(screen.getByText("RFC1918 私网")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "复制地址 192.168.1.5/24" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("192.168.1.5/24"));
  expect((await screen.findByRole("status")).textContent).toContain("地址已复制");
});

it("shows an accessible loading workspace before the native snapshot resolves", async () => {
  let resolveSnapshot!: (snapshot: NetworkAddressesSnapshot) => void;
  const loadSnapshot = vi.fn(() => new Promise<NetworkAddressesSnapshot>((resolve) => { resolveSnapshot = resolve; }));
  render(<NetworkAddressesTool loadSnapshot={loadSnapshot} />);

  const panel = screen.getByRole("tabpanel", { name: "本机网卡" });
  expect(panel.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("status").textContent).toContain("正在读取本机接口…");

  await act(async () => {
    resolveSnapshot({ sampledAtMs: Date.UTC(2026, 7, 31, 15, 0), interfaces: [] });
  });
  await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("false"));
  expect(screen.getByText("没有返回接口地址。空结果不代表网络不可用。")).toBeTruthy();
});

it("keeps tabs keyboard-accessible with roving tab focus", async () => {
  const loadSnapshot = vi.fn(async () => ({ sampledAtMs: Date.now(), interfaces: [] }));
  render(<NetworkAddressesTool loadSnapshot={loadSnapshot} />);
  const liveTab = screen.getByRole("tab", { name: "本机网卡" });
  const ifconfigTab = screen.getByRole("tab", { name: "粘贴 ifconfig" });

  fireEvent.keyDown(liveTab, { key: "ArrowRight" });
  expect(ifconfigTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(ifconfigTab);
  expect(screen.getByRole("textbox", { name: "ifconfig 文本" })).toBeTruthy();
});

it("parses pasted BSD/Linux text and exposes unknown lines without executing input", async () => {
  const loadSnapshot = vi.fn(async () => ({ sampledAtMs: Date.now(), interfaces: [] }));
  render(<NetworkAddressesTool loadSnapshot={loadSnapshot} />);
  fireEvent.click(screen.getByRole("tab", { name: "粘贴 ifconfig" }));
  fireEvent.change(screen.getByRole("textbox", { name: "ifconfig 文本" }), {
    target: { value: "2: eth0: <BROADCAST,UP> mtu 1500 state UP\n\tinet 10.0.0.2 netmask 0xffffff00\n\tcarrier_changes 2\n" },
  });
  fireEvent.click(screen.getByRole("button", { name: "严格解析" }));

  expect(await screen.findByText("eth0")).toBeTruthy();
  expect(screen.getByText("未知行")).toBeTruthy();
  expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it("does not read native addresses when opened as a paste-only parser", async () => {
  const loadSnapshot = vi.fn(async () => ({ sampledAtMs: Date.now(), interfaces: [] }));
  render(<NetworkAddressesTool loadSnapshot={loadSnapshot} initialView="ifconfig" />);
  expect(loadSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "本机网卡" }));
  await waitFor(() => expect(loadSnapshot).toHaveBeenCalledOnce());
});

it("discards native errors that arrive after switching to paste-only mode", async () => {
  let rejectSnapshot!: (reason: Error) => void;
  const loadSnapshot = vi.fn(() => new Promise<NetworkAddressesSnapshot>((_resolve, reject) => { rejectSnapshot = reject; }));
  render(<NetworkAddressesTool loadSnapshot={loadSnapshot} />);
  fireEvent.click(screen.getByRole("tab", { name: "粘贴 ifconfig" }));
  await act(async () => { rejectSnapshot(new ToolboxInputError("late_failure", "Stale native failure")); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("textbox", { name: "ifconfig 文本" })).toBeTruthy();
});
