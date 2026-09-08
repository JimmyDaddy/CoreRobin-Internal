/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type {
  AiSettings as Settings,
  AiState,
  CapabilityRecord,
  ConnectionProfile,
  SaveConnectionInput,
} from "../../ai/types";

const api = vi.hoisted(() => ({
  openHelp: vi.fn(),
  getState: vi.fn(),
  onChange: vi.fn(),
  updateSettings: vi.fn(),
  saveConnection: vi.fn(),
  setCredential: vi.fn(),
  setProxyCredential: vi.fn(),
  deleteCredential: vi.fn(),
  deleteProxyCredential: vi.fn(),
  listModels: vi.fn(),
  testModel: vi.fn(),
  clearConversations: vi.fn(),
  deleteConnection: vi.fn(),
}));
vi.mock("../../ai/api", () => ({ aiApi: api }));
import { AiSettings } from "./AiSettings";

let nativeState: AiState;
const profile: ConnectionProfile = {
  id: "ollama",
  revision: 1,
  name: "本机 Ollama",
  protocol: "ollama_native",
  apiBaseUrl: "http://127.0.0.1:11434",
  authKind: "none",
  authHeaderName: null,
  networkPolicy: "loopback",
  proxyUrl: null,
  proxyNetworkPolicy: null,
  proxyCredentialStatus: "not_required",
  anthropicWorkspaceId: null,
  chatTokenLimitParameter: "auto",
  timeoutSeconds: 180,
  maxOutputTokens: 1024,
  stream: true,
  credentialStatus: "not_required",
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh-CN");
  nativeState = {
    capabilities: [],
    settings: {
      enabled: false,
      defaultModel: null,
      storageBudgetBytes: 268435456,
      localConnectionsOnly: false,
    },
    connections: [clone(profile)],
    activeRun: null,
    storageBytes: 1024,
    storageWarning: false,
    requestEpoch: 1,
  };
  api.getState.mockImplementation(async () => clone(nativeState));
  api.openHelp.mockResolvedValue(undefined);
  api.onChange.mockResolvedValue(() => {});
  api.updateSettings.mockImplementation(async (settings: Settings) => {
    nativeState.settings = settings;
    return clone(nativeState);
  });
  api.saveConnection.mockImplementation(async (input: SaveConnectionInput) => {
    const existing = nativeState.connections.find(
      (item) => item.id === input.id,
    );
    if (existing && input.expectedRevision !== existing.revision) {
      throw { code: "stale_revision", message: "连接已在其他窗口更新" };
    }
    const saved = {
      ...input,
      id: input.id ?? "new-connection",
      revision: (input.expectedRevision ?? 0) + 1,
      credentialStatus: existing?.credentialStatus ?? ("missing" as const),
      proxyCredentialStatus:
        existing?.proxyCredentialStatus ?? ("not_required" as const),
    };
    nativeState.connections = nativeState.connections
      .filter((item) => item.id !== saved.id)
      .concat(saved);
    return clone(saved);
  });
  api.setCredential.mockImplementation(async (id, _secret, temporary) => {
    const current = nativeState.connections.find((item) => item.id === id)!;
    current.revision += 1;
    current.credentialStatus = temporary ? "temporary" : "saved";
  });
  api.setProxyCredential.mockImplementation(
    async (id, _user, _password, temporary) => {
      const current = nativeState.connections.find((item) => item.id === id)!;
      current.revision += 1;
      current.proxyCredentialStatus = temporary ? "temporary" : "saved";
    },
  );
  api.deleteCredential.mockImplementation(async (id) => {
    const current = nativeState.connections.find((item) => item.id === id)!;
    current.revision += 1;
    current.credentialStatus = "missing";
  });
  api.deleteProxyCredential.mockImplementation(async (id) => {
    const current = nativeState.connections.find((item) => item.id === id)!;
    current.revision += 1;
    current.proxyCredentialStatus = "missing";
  });
  api.listModels.mockResolvedValue([]);
  api.testModel.mockResolvedValue({
    text: "Test reply",
    usage: null,
    reportedModel: null,
  });
  api.clearConversations.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

async function loaded() {
  await screen.findByRole("button", { name: "编辑" });
}
function editor() {
  return screen.getByLabelText("连接名称").closest("form")!;
}
const capability = (
  kind: CapabilityRecord["kind"],
  status: CapabilityRecord["status"],
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord => ({
  connectionId: profile.id,
  profileRevision: profile.revision,
  modelId: kind === "address" || kind === "discovery" ? "" : "model-one",
  checkedAt: 1788822000000,
  kind,
  status,
  ...overrides,
});
function capabilityRow(label: string) {
  return within(
    screen.getByRole("region", { name: i18n.t("ai:capabilitiesTitle") }),
  )
    .getByText(label)
    .closest("li")!;
}

describe("AiSettings explicit native configuration", () => {
  it("shows only checks for the saved connection revision and selected model", async () => {
    nativeState.capabilities = [
      capability("address", "verified"),
      capability("discovery", "failed"),
      capability("text", "verified", { modelId: "different-model" }),
      capability("text", "verified", { profileRevision: 0 }),
      capability("text", "expired"),
    ];
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(within(editor()).getByLabelText("模型 ID"), { target: { value: "model-one" } });
    expect(within(capabilityRow(i18n.t("ai:capabilityAddress"))).getByText(i18n.t("ai:capabilityVerified"))).toBeTruthy();
    expect(within(capabilityRow(i18n.t("ai:capabilityDiscovery"))).getByText(i18n.t("ai:capabilityFailed"))).toBeTruthy();
    const text = capabilityRow(i18n.t("ai:capabilityText"));
    expect(within(text).getByText(i18n.t("ai:capabilityExpired"))).toBeTruthy();
    expect(text.querySelector("time")?.dateTime).toBe(new Date(1788822000000).toISOString());
    expect(screen.getByText(i18n.t("ai:capabilityScopeHint"))).toBeTruthy();
    expect(screen.getByText(i18n.t("ai:capabilityAddressHint"))).toBeTruthy();
    fireEvent.change(within(editor()).getByLabelText("模型 ID"), { target: { value: "different-model" } });
    expect(within(capabilityRow(i18n.t("ai:capabilityText"))).getByText(i18n.t("ai:capabilityVerified"))).toBeTruthy();
    expect(api.testModel).not.toHaveBeenCalled();
  });
  it("tests a text response only after a user click without changing connection parameters", async () => {
    api.testModel.mockImplementation(async () => {
      nativeState.capabilities.push(capability("text", "verified"));
      return { text: "Synthetic reply", usage: null, reportedModel: null };
    });
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(within(editor()).getByLabelText("模型 ID"), { target: { value: "model-one" } });
    expect(api.testModel).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t("ai:testHint"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:testModel") }));
    await waitFor(() => expect(within(capabilityRow(i18n.t("ai:capabilityText"))).queryByText(i18n.t("ai:capabilityVerified"))).toBeTruthy());
    expect(api.testModel).toHaveBeenCalledExactlyOnceWith({ connectionId: "ollama", modelId: "model-one" });
    expect(api.saveConnection).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
  it.each(["discovery", "text"] as const)(
    "refreshes a failed %s check without automatically retrying",
    async (kind) => {
      const fail = async () => {
        nativeState.capabilities.push(capability(kind, "failed"));
        throw { code: "timeout", message: "Synthetic check timed out" };
      };
      if (kind === "discovery") api.listModels.mockImplementation(fail);
      else api.testModel.mockImplementation(fail);
      render(<AiSettings />);
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      fireEvent.change(within(editor()).getByLabelText("模型 ID"), {
        target: { value: "model-one" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t(
            kind === "discovery" ? "ai:refreshModels" : "ai:testModel",
          ),
        }),
      );
      await screen.findByRole("alert");
      expect(
        within(
          capabilityRow(
            i18n.t(
              kind === "discovery"
                ? "ai:capabilityDiscovery"
                : "ai:capabilityText",
            ),
          ),
        ).getByText(i18n.t("ai:capabilityFailed")),
      ).toBeTruthy();
      expect(
        kind === "discovery" ? api.listModels : api.testModel,
      ).toHaveBeenCalledOnce();
      expect(
        (within(editor()).getByLabelText("模型 ID") as HTMLInputElement).value,
      ).toBe("model-one");
    },
  );
  it("requires explicit adoption of a full generation URL without saving or connecting", async () => {
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const input = screen.getByLabelText("API Base URL") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "http://127.0.0.1:11434/api/chat" },
    });
    expect(input.value).toBe("http://127.0.0.1:11434/api/chat");
    expect(
      screen.getByText(
        i18n.t("ai:suggestedBase", { base: "http://127.0.0.1:11434" }),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        i18n.t("ai:generationEndpoint", { endpoint: input.value }),
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("ai:useSuggestedBase") }),
    );
    expect(input.value).toBe("http://127.0.0.1:11434");
    expect(
      screen.queryByRole("button", { name: i18n.t("ai:useSuggestedBase") }),
    ).toBeNull();
    expect(api.saveConnection).not.toHaveBeenCalled();
    expect(api.testModel).not.toHaveBeenCalled();
    expect(api.listModels).not.toHaveBeenCalled();
  });
  it("opens only static official help topics and marks discovered remote processing", async () => {
    api.listModels.mockResolvedValue([
      { id: "cloud-model", name: "Cloud model", processingLocation: "remote" },
    ]);
    render(<AiSettings />);
    await loaded();
    expect(api.openHelp).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("ai:helpProvider", { provider: "Ollama" }),
      }),
    );
    await waitFor(() => expect(api.openHelp).toHaveBeenCalledWith("ollama"));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: i18n.t("ai:dataPrivacyHelp"),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("ai:dataPrivacyHelp") }),
    );
    await waitFor(() =>
      expect(api.openHelp).toHaveBeenCalledWith("openai-data"),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("ai:refreshModels") }),
    );
    await screen.findByText(`Cloud model · ${i18n.t("ai:processingRemote")}`);
    fireEvent.change(within(editor()).getByLabelText("模型 ID"), {
      target: { value: "cloud-model" },
    });
    expect(
      screen.getByText(
        `${i18n.t("ai:processingLocation")}: ${i18n.t("ai:processingRemote")}`,
      ),
    ).toBeTruthy();
    expect(api.testModel).not.toHaveBeenCalled();
  });
  it("loads disabled settings without model calls and acknowledges readiness once", async () => {
    const onReady = vi.fn();
    render(<AiSettings onReady={onReady} />);
    await loaded();
    expect(
      (screen.getByRole("switch", { name: "启用 AI" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(api.testModel).not.toHaveBeenCalled();
    expect(api.listModels).not.toHaveBeenCalled();
    expect(api.saveConnection).not.toHaveBeenCalled();
  });
  it.each([
    { label: "超时时间（秒）", min: 10, max: 300 },
    { label: "最大输出 Token", min: 32, max: 8192 },
    { label: "存储预算（MiB）", min: 8, max: 2048 },
  ])(
    "accepts native $label boundaries and rejects values outside them",
    async ({ label, min, max }) => {
      render(<AiSettings />);
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      const input = screen.getByLabelText(label) as HTMLInputElement;
      for (const [value, valid] of [
        [min - 1, false],
        [min, true],
        [max, true],
        [max + 1, false],
      ] as const) {
        fireEvent.change(input, { target: { value: String(value) } });
        expect(input.checkValidity()).toBe(valid);
      }
      expect(api.saveConnection).not.toHaveBeenCalled();
      expect(api.updateSettings).not.toHaveBeenCalled();
    },
  );
  it("blocks an output limit below 32 and submits the valid native minimum", async () => {
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const form = editor();
    const controls = within(form);
    const output = controls.getByLabelText("最大输出 Token");
    const save = controls.getByRole("button", { name: "保存" });
    fireEvent.change(output, { target: { value: "31" } });
    expect(form.checkValidity()).toBe(false);
    fireEvent.click(save);
    expect(api.saveConnection).not.toHaveBeenCalled();
    fireEvent.change(output, { target: { value: "32" } });
    expect(form.checkValidity()).toBe(true);
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.saveConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ollama", maxOutputTokens: 32 }),
      ),
    );
    await screen.findByText("连接已保存，未发送模型请求。");
  });
  it("persists configuration and credential separately without sending a model request", async () => {
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    const form = editor();
    const controls = within(form);
    fireEvent.change(controls.getByLabelText("模型连接"), {
      target: { value: "anthropic" },
    });
    expect(
      (controls.getByLabelText("API 协议") as HTMLSelectElement).value,
    ).toBe("anthropic_messages");
    fireEvent.change(controls.getByLabelText("凭据"), {
      target: { value: "test-credential-not-real" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(api.setCredential).toHaveBeenCalledWith(
        "new-connection",
        "test-credential-not-real",
        false,
      ),
    );
    expect(api.saveConnection.mock.calls[0]![0]).not.toHaveProperty("secret");
    expect(api.testModel).not.toHaveBeenCalled();
    expect(api.listModels).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((controls.getByLabelText("凭据") as HTMLInputElement).value).toBe(
        "",
      ),
    );
  });
  it("keeps a repairable connection if credential storage fails and never sends the key to a model", async () => {
    api.setCredential.mockImplementationOnce(async (id) => {
      const current = nativeState.connections.find((item) => item.id === id)!;
      current.revision += 1;
      throw {
        code: "credential_unavailable",
        message: "系统凭据服务不可用",
      };
    });
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    const form = editor();
    const controls = within(form);
    fireEvent.change(controls.getByLabelText("模型连接"), {
      target: { value: "anthropic" },
    });
    fireEvent.change(controls.getByLabelText("凭据"), {
      target: { value: "test-credential-not-real" },
    });
    fireEvent.submit(form);
    await screen.findByRole("alert");
    expect(api.saveConnection).toHaveBeenCalledOnce();
    expect(
      nativeState.connections.some((item) => item.id === "new-connection"),
    ).toBe(true);
    expect((controls.getByLabelText("凭据") as HTMLInputElement).value).toBe(
      "test-credential-not-real",
    );
    expect(api.testModel).not.toHaveBeenCalled();
    expect(api.listModels).not.toHaveBeenCalled();
    fireEvent.click(controls.getByLabelText("仅保留凭据到应用退出"));
    fireEvent.submit(form);
    await screen.findByText("连接已保存，未发送模型请求。");
    expect(api.saveConnection.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ id: "new-connection", expectedRevision: 2 }),
    );
    expect(api.setCredential).toHaveBeenLastCalledWith(
      "new-connection",
      "test-credential-not-real",
      true,
    );
    expect((controls.getByLabelText("凭据") as HTMLInputElement).value).toBe(
      "",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("saves again after both credential revisions change and preserves unsaved edits when credentials are deleted", async () => {
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    const form = editor();
    const controls = within(form);
    fireEvent.change(controls.getByLabelText("模型连接"), {
      target: { value: "anthropic" },
    });
    fireEvent.change(controls.getByLabelText("凭据"), {
      target: { value: "test-credential-not-real" },
    });
    fireEvent.change(controls.getByLabelText(/代理地址/), {
      target: { value: "http://127.0.0.1:8080" },
    });
    fireEvent.change(controls.getByLabelText("代理用户名"), {
      target: { value: "proxy-user" },
    });
    fireEvent.change(controls.getByLabelText("代理密码"), {
      target: { value: "proxy-password" },
    });
    fireEvent.submit(form);
    await screen.findByText("连接已保存，未发送模型请求。");
    expect(
      nativeState.connections.find((item) => item.id === "new-connection")
        ?.revision,
    ).toBe(3);
    fireEvent.change(controls.getByLabelText("连接名称"), {
      target: { value: "Renamed connection" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledTimes(2));
    await screen.findByText("连接已保存，未发送模型请求。");
    expect(api.saveConnection.mock.calls[1]![0].expectedRevision).toBe(3);
    fireEvent.change(controls.getByLabelText("连接名称"), {
      target: { value: "Unsaved name retained" },
    });
    fireEvent.click(
      controls.getByRole("button", { name: "删除凭据", hidden: true }),
    );
    await waitFor(() => expect(api.deleteCredential).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(form.querySelector("fieldset")!.disabled).toBe(false),
    );
    fireEvent.click(
      controls.getByRole("button", { name: "删除代理凭据", hidden: true }),
    );
    await waitFor(() =>
      expect(api.deleteProxyCredential).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(form.querySelector("fieldset")!.disabled).toBe(false),
    );
    expect(
      (controls.getByLabelText("连接名称") as HTMLInputElement).value,
    ).toBe("Unsaved name retained");
    fireEvent.submit(form);
    await screen.findByText("连接已保存，未发送模型请求。");
    expect(api.saveConnection.mock.calls[2]![0]).toEqual(
      expect.objectContaining({
        expectedRevision: 6,
        name: "Unsaved name retained",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("requires saving changed endpoints before model discovery or testing", async () => {
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const controls = within(editor());
    fireEvent.change(controls.getByLabelText("API Base URL"), {
      target: { value: "https://different.example/v1" },
    });
    expect(
      (
        controls.getByRole("button", {
          name: "刷新模型列表",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/请重新填写凭据/)).toBeTruthy();
    expect(api.listModels).not.toHaveBeenCalled();
    expect(api.testModel).not.toHaveBeenCalled();
  });
  it("allows a manual model after discovery fails and sets it as default without a generation request", async () => {
    api.listModels.mockRejectedValue({
      code: "not_supported",
      message: "模型目录不可用",
    });
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const controls = within(editor());
    fireEvent.click(controls.getByRole("button", { name: "刷新模型列表" }));
    await screen.findByRole("alert");
    fireEvent.change(controls.getByLabelText("模型 ID"), {
      target: { value: "my-local-model" },
    });
    fireEvent.click(controls.getByRole("button", { name: "设为默认" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          defaultModel: { connectionId: "ollama", modelId: "my-local-model" },
        }),
      ),
    );
    expect(api.testModel).not.toHaveBeenCalled();
  });
  it("only clears conversations after confirmation and retains settings and connections", async () => {
    render(<AiSettings />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "清空全部对话" }));
    expect(api.clearConversations).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "取消",
      }),
    );
    expect(api.clearConversations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清空全部对话" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "删除",
      }),
    );
    await waitFor(() => expect(api.clearConversations).toHaveBeenCalledOnce());
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(api.deleteConnection).not.toHaveBeenCalled();
  });
});
