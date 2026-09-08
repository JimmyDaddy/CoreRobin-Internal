/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import i18n from "../../i18n";
import type {
  AiMessage,
  AiMessagePosition,
  AiSession,
  AiSessionContext,
  AiState,
  PreparedAnalysis,
  ValidatedResult,
} from "../../ai/types";

const api = vi.hoisted(() => ({
  getState: vi.fn(),
  onChange: vi.fn(),
  onVisibility: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  saveDraft: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  selectModel: vi.fn(),
  clearConversations: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  setSessionContext: vi.fn(),
}));
vi.mock("../../ai/api", () => ({ aiApi: api }));
import { AiAssistant } from "./AiAssistant";

let nativeSession: AiSession;
let nativeState: AiState;
let preview: PreparedAnalysis;
let deleted: boolean;
const listeners = new Set<() => void>();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
beforeEach(async () => {
  vi.clearAllMocks();
  listeners.clear();
  deleted = false;
  await i18n.changeLanguage("zh-CN");
  nativeSession = {
    id: "conversation-1",
    title: "旧会话",
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    temporary: false,
    selectedModel: { connectionId: "local", modelId: "existing-model" },
    draftText: "",
    draftRevision: 1,
    storageStatus: "saved",
    sourceCategories: [],
    messages: [],
    scenario: "current_status",
    incidentId: null,
    fromMs: null,
    toMs: null,
  };
  nativeState = {
    capabilities: [],
    settings: {
      enabled: true,
      defaultModel: { connectionId: "cloud", modelId: "new-default" },
      storageBudgetBytes: 268435456,
      localConnectionsOnly: false,
    },
    connections: [
      {
        id: "local",
        revision: 1,
        name: "本机服务",
        protocol: "ollama_native",
        apiBaseUrl: "http://127.0.0.1:11434",
        authKind: "none",
        networkPolicy: "loopback",
        proxyUrl: null,
        proxyNetworkPolicy: null,
        timeoutSeconds: 180,
        maxOutputTokens: 1024,
        stream: true,
        credentialStatus: "not_required",
        proxyCredentialStatus: "not_required",
        authHeaderName: null,
        anthropicWorkspaceId: null,
        chatTokenLimitParameter: "auto",
      },
      {
        id: "cloud",
        revision: 1,
        name: "云服务",
        protocol: "anthropic_messages",
        apiBaseUrl: "https://model.example/v1",
        authKind: "api_key",
        networkPolicy: "public",
        proxyUrl: null,
        proxyNetworkPolicy: null,
        timeoutSeconds: 120,
        maxOutputTokens: 1024,
        stream: true,
        credentialStatus: "saved",
        proxyCredentialStatus: "not_required",
        authHeaderName: null,
        anthropicWorkspaceId: null,
        chatTokenLimitParameter: "auto",
      },
    ],
    activeRun: null,
    storageBytes: 0,
    storageWarning: false,
    requestEpoch: 1,
  };
  preview = {
    id: "prepared-1",
    sessionId: nativeSession.id,
    sessionRevision: 1,
    expiresAt: Date.now() + 60000,
    selection: nativeSession.selectedModel!,
    connectionName: "本机服务",
    endpoint: "http://127.0.0.1:11434",
    protocol: "ollama_native",
    preview: "CPU 30%\n用户：现在怎么样？",
    userText: "现在怎么样？",
    scenario: "current_status",
    sourceCategories: ["resources"],
    coverage: ["Only current data available"],
    requestEpoch: 1,
    history: [],
    proxyUrl: null,
  };
  api.getState.mockImplementation(async () => clone(nativeState));
  api.onChange.mockImplementation(async (callback: () => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  });
  api.onVisibility.mockResolvedValue(() => {});
  api.listSessions.mockImplementation(async () => ({
    sessions: deleted ? [] : [clone(nativeSession)],
    hasMore: false,
  }));
  api.getSession.mockImplementation(async () => {
    if (deleted) throw { code: "not_found", message: "Deleted" };
    return clone(nativeSession);
  });
  api.createSession.mockImplementation(
    async (input: { temporary?: boolean } & Partial<AiSessionContext> = {}) => {
      deleted = false;
      nativeSession = {
        ...nativeSession,
        id: "conversation-new",
        title: "新会话",
        temporary: !!input.temporary,
        selectedModel: nativeState.settings.defaultModel,
        messages: [],
        draftText: "",
        revision: 1,
        draftRevision: 1,
        scenario: input.scenario ?? "current_status",
        incidentId: input.incidentId ?? null,
        fromMs: input.fromMs ?? null,
        toMs: input.toMs ?? null,
      };
      return clone(nativeSession);
    },
  );
  api.saveDraft.mockImplementation(
    async (_id: string, revision: number, text: string) => {
      if (revision !== nativeSession.draftRevision) {
        throw { code: "draft_conflict", message: "Draft changed" };
      }
      nativeSession = {
        ...nativeSession,
        draftText: text,
        draftRevision: nativeSession.draftRevision + 1,
      };
      return clone(nativeSession);
    },
  );
  api.prepare.mockImplementation(async () => clone(preview));
  api.start.mockImplementation(
    async (_preparationId: string, submissionId: string) => {
      const run = {
        requestId: "run-1",
        sessionId: nativeSession.id,
        submissionId,
        state: "streaming" as const,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      nativeState.activeRun = run;
      nativeSession = {
        ...nativeSession,
        draftText: "",
        draftRevision: nativeSession.draftRevision + 1,
        revision: nativeSession.revision + 1,
        messages: [
          {
            id: "message-1",
            role: "user",
            content: preview.userText,
            createdAt: Date.now(),
            status: "complete",
            requestId: run.requestId,
            modelLabel: null,
            sourceCategories: [],
            reusableInContext: true,
            usage: null,
          },
        ],
      };
      return clone(run);
    },
  );
  api.cancel.mockImplementation(async () => {
    nativeState.activeRun = null;
  });
  api.clearConversations.mockImplementation(async () => {
    deleted = true;
  });
  api.deleteSession.mockImplementation(async () => {
    deleted = true;
  });
  api.selectModel.mockImplementation(
    async (
      _id: string,
      _revision: number,
      selection: AiSession["selectedModel"],
    ) => {
      nativeSession = {
        ...nativeSession,
        selectedModel: selection,
        revision: nativeSession.revision + 1,
      };
      return clone(nativeSession);
    },
  );
  api.setSessionContext.mockImplementation(
    async (_id: string, _revision: number, context: AiSessionContext) => {
      nativeSession = {
        ...nativeSession,
        ...context,
        revision: nativeSession.revision + 1,
      };
      return clone(nativeSession);
    },
  );
});
afterEach(() => cleanup());

async function loaded() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "切换模型" }).textContent,
    ).toContain("existing-model"),
  );
}
function compose(text = "现在怎么样？") {
  fireEvent.change(screen.getByRole("textbox", { name: "给 Robin 的消息" }), {
    target: { value: text },
  });
}
const linkedResult = (): ValidatedResult => ({
  result: {
    summary: "Device snapshot explanation",
    findings: [
      {
        statement: "CPU load has headroom",
        evidenceIds: ["E1"],
        kind: "observation",
      },
      {
        statement: "The application may be waiting for a remote service",
        evidenceIds: [],
        kind: "hypothesis",
      },
    ],
    unknowns: ["This snapshot cannot establish an application's cause."],
    nextSteps: [{ target: "history", evidenceIds: ["E1"] }],
  },
  evidence: [{ id: "E1", label: "Local CPU usage", value: "17.5", unit: "%" }],
});
const reply = (
  status: AiMessage["status"],
  validatedResult?: ValidatedResult,
): AiMessage => ({
  id: "structured-reply",
  role: "assistant",
  content: "Raw model reply",
  status,
  createdAt: 1000,
  requestId: "run-1",
  modelLabel: "existing-model",
  sourceCategories: ["resources"],
  reusableInContext: true,
  usage: null,
  validatedResult,
});

describe("AiAssistant native conversation lifecycle", () => {
  it("hands off a visible message anchor and restores its page and offset, including a new handoff to the same session", async () => {
    const page = (before?: number): AiSession => ({
      ...clone(nativeSession),
      messages: Array.from({ length: 10 }, (_, index) => {
        const ordinal = (before === 30 ? 20 : 30) + index;
        return {
          ...reply("complete"),
          id: `message-${ordinal}`,
          content: `Position message ${ordinal}`,
        };
      }),
      totalMessages: 40,
      messageOffset: before === 30 ? 20 : 30,
      hasOlderMessages: true,
    });
    api.getSession.mockImplementation(async (_id: string, before?: number) =>
      page(before),
    );
    const onExpand = vi.fn();
    let mainWindow = false;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScroll = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const rect = (top: number, bottom: number) => ({
      top,
      bottom,
      left: 0,
      right: 400,
      width: 400,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("ai-messages")) return rect(100, 300);
        if (this.dataset.aiMessageId) {
          const ordinal = Number(this.dataset.aiMessageId.split("-")[1]);
          const scroll = this.parentElement?.scrollTop ?? 0;
          const top = (mainWindow ? 140 : 70) + (ordinal - 20) * 100 - scroll;
          return rect(top, top + 80);
        }
        return originalRect.call(this);
      });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: function (this: HTMLElement) {
        const viewport = this.closest<HTMLElement>(".ai-messages");
        if (viewport) viewport.scrollTop = 999;
      },
    });
    try {
      const bubble = render(<AiAssistant compact onExpand={onExpand} />);
      await screen.findByText("Position message 39");
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("ai:olderMessages") }),
      );
      await screen.findByText("Position message 20");
      (
        bubble.container.querySelector(".ai-messages") as HTMLElement
      ).scrollTop = 0;
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("ai:expand") }),
      );
      const position: AiMessagePosition = {
        before: 30,
        anchorId: "message-20",
        anchorOffset: -30,
      };
      await waitFor(() =>
        expect(onExpand).toHaveBeenCalledWith("conversation-1", position),
      );
      bubble.unmount();
      mainWindow = true;
      api.getSession.mockClear();
      const main = render(
        <AiAssistant sessionId="conversation-1" restorePosition={position} />,
      );
      await screen.findByText("Position message 20");
      expect(api.getSession).toHaveBeenCalledWith("conversation-1", 30);
      const viewport = main.container.querySelector(
        ".ai-messages",
      ) as HTMLElement;
      expect(viewport.scrollTop).toBe(70);
      api.getSession.mockClear();
      act(() => {
        for (const listener of listeners) listener();
      });
      await waitFor(() =>
        expect(api.getSession).toHaveBeenCalledWith("conversation-1", 30),
      );
      expect(viewport.scrollTop).toBe(70);
      api.getSession.mockClear();
      main.rerender(
        <AiAssistant
          sessionId="conversation-1"
          restorePosition={{
            before: 30,
            anchorId: "message-21",
            anchorOffset: 10,
          }}
        />,
      );
      await waitFor(() => expect(viewport.scrollTop).toBe(130));
      expect(api.getSession).toHaveBeenCalledWith("conversation-1", 30);
    } finally {
      bounds.mockRestore();
      if (originalScroll)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScroll,
        );
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });
  it.each([
    "pending",
    "streaming",
    "failed",
    "interrupted",
    "cancelled",
  ] as const)(
    "does not render evidence cards for a %s message even if result data is present",
    async (status) => {
      nativeSession.messages = [reply(status, linkedResult())];
      render(<AiAssistant onOpenEvidenceSource={vi.fn()} />);
      await screen.findByText("Raw model reply");
      expect(
        screen.queryByRole("region", { name: i18n.t("ai:resultTitle") }),
      ).toBeNull();
      expect(screen.queryByText("Local CPU usage")).toBeNull();
    },
  );
  it("keeps unvalidated model HTML and action-like JSON as inert text", async () => {
    const onOpenEvidenceSource = vi.fn();
    const raw =
      '<img src=x onerror="alert(1)"> {"nextSteps":[{"target":"shell:rm","url":"https://model.invalid/action"}]}';
    nativeSession.messages = [{ ...reply("complete"), content: raw }];
    const { container } = render(
      <AiAssistant onOpenEvidenceSource={onOpenEvidenceSource} />,
    );
    await screen.findByText(raw);
    expect(screen.getByText(i18n.t("ai:resultUnlinked"))).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: i18n.t("ai:resultTitle") }),
    ).toBeNull();
    expect(
      container.querySelector(
        ".ai-message img, .ai-message a, .ai-message button",
      ),
    ).toBeNull();
    expect(onOpenEvidenceSource).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });
  it("renders only local evidence values and fixed navigation from a completed validated result", async () => {
    const validated = linkedResult();
    Object.assign(validated.result.findings[0]!, {
      value: "99999",
      unit: "model-invented-unit",
    });
    Object.assign(validated.result.nextSteps[0]!, {
      command: "unsafe-command",
      url: "https://model.invalid/action",
    });
    validated.result.nextSteps.push(
      { target: "network", evidenceIds: [] },
      { target: "current_status", evidenceIds: [] },
    );
    validated.result.nextSteps.push({
      target: "shell:rm",
      evidenceIds: [],
    } as unknown as ValidatedResult["result"]["nextSteps"][number]);
    validated.result.unknowns.push(
      '<a href="https://model.invalid">Untrusted model markup</a>',
    );
    nativeSession.messages = [reply("complete", validated)];
    const onOpenEvidenceSource = vi.fn();
    render(<AiAssistant onOpenEvidenceSource={onOpenEvidenceSource} />);
    const card = await screen.findByRole("region", {
      name: i18n.t("ai:resultTitle"),
    });
    const result = within(card);
    expect(result.getByText("Device snapshot explanation")).toBeTruthy();
    expect(result.getByText(i18n.t("ai:resultObservation"))).toBeTruthy();
    expect(result.getByText(i18n.t("ai:resultHypothesis"))).toBeTruthy();
    expect(result.getAllByText("17.5 %")).toHaveLength(2);
    expect(result.getByText(i18n.t("ai:resultEvidenceHint"))).toBeTruthy();
    expect(
      result.queryByText(/99999|model-invented-unit|unsafe-command|shell:rm/),
    ).toBeNull();
    expect(screen.queryByText("Raw model reply")).toBeNull();
    expect(card.querySelector("a, img, iframe")).toBeNull();
    expect(result.getAllByRole("button")).toHaveLength(3);
    expect(onOpenEvidenceSource).not.toHaveBeenCalled();
    compose();
    fireEvent.click(
      result.getByRole("button", { name: i18n.t("ai:scenarioHistory") }),
    );
    await waitFor(() =>
      expect(onOpenEvidenceSource).toHaveBeenCalledWith("history"),
    );
    expect(onOpenEvidenceSource).toHaveBeenCalledOnce();
    expect(api.saveDraft).toHaveBeenCalledWith(
      "conversation-1",
      1,
      "现在怎么样？",
    );
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("shows fixed source names without adding actions when navigation is unavailable", async () => {
    nativeSession.messages = [reply("complete", linkedResult())];
    render(<AiAssistant />);
    const card = await screen.findByRole("region", {
      name: i18n.t("ai:resultTitle"),
    });
    expect(within(card).getByText(i18n.t("ai:scenarioHistory"))).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  });
  it("prepares in the app language and separates a local connection from remote processing", async () => {
    await i18n.changeLanguage("ja");
    preview.connectionLocation = "loopback";
    preview.processingLocation = "remote";
    render(<AiAssistant />);
    await screen.findByRole("button", { name: i18n.t("ai:switchModel") });
    fireEvent.change(
      screen.getByRole("textbox", { name: i18n.t("ai:input") }),
      { target: { value: "Answer in English please" } },
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:preview") }));
    const review = await screen.findByRole("region", {
      name: i18n.t("ai:previewTitle"),
    });
    expect(api.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "ja",
        text: "Answer in English please",
      }),
    );
    expect(
      within(review).getByText(
        `${i18n.t("ai:connectionLocation")}: ${i18n.t("ai:loopback")}`,
      ),
    ).toBeTruthy();
    expect(
      within(review).getByText(
        `${i18n.t("ai:processingLocation")}: ${i18n.t("ai:processingRemote")}`,
      ),
    ).toBeTruthy();
    expect(
      within(review).getByText(i18n.t("ai:processingNotice")),
    ).toBeTruthy();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("replaces message pages, deduplicates page clicks and retains unsaved drafts", async () => {
    nativeSession.messages = Array.from({ length: 65 }, (_, index) => ({
      ...reply("complete"),
      id: `message-${index}`,
      content: `Conversation message ${index}`,
    }));
    const page = (before = nativeSession.messages.length): AiSession => {
      const end = Math.min(before, nativeSession.messages.length);
      const start = Math.max(0, end - 30);
      return clone({
        ...nativeSession,
        messages: nativeSession.messages.slice(start, end),
        totalMessages: nativeSession.messages.length,
        messageOffset: start,
        hasOlderMessages: start > 0,
      });
    };
    api.getSession.mockImplementation(async (_id: string, before?: number) =>
      page(before),
    );
    api.saveDraft.mockImplementation(
      async (_id: string, revision: number, text: string) => {
        expect(revision).toBe(nativeSession.draftRevision);
        nativeSession.draftText = text;
        nativeSession.draftRevision += 1;
        return page();
      },
    );
    const { container } = render(<AiAssistant compact />);
    await screen.findByText("Conversation message 64");
    expect(container.querySelectorAll(".ai-message")).toHaveLength(30);
    expect(screen.queryByText("Conversation message 34")).toBeNull();
    compose();
    api.getSession.mockClear();
    const older = screen.getByRole("button", {
      name: i18n.t("ai:olderMessages"),
    });
    fireEvent.click(older);
    fireEvent.click(older);
    await screen.findByText("Conversation message 5");
    expect(api.getSession).toHaveBeenCalledExactlyOnceWith(
      "conversation-1",
      35,
    );
    expect(container.querySelectorAll(".ai-message")).toHaveLength(30);
    expect(screen.queryByText("Conversation message 64")).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: i18n.t("ai:input"),
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("现在怎么样？");
    fireEvent.change(
      screen.getByRole("textbox", { name: i18n.t("ai:input") }),
      { target: { value: "Draft edited while reading history" } },
    );
    fireEvent.blur(screen.getByRole("textbox", { name: i18n.t("ai:input") }));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Conversation message 5")).toBeTruthy();
    api.getSession.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("ai:latestMessages") }),
    );
    await screen.findByText("Conversation message 64");
    expect(api.getSession).toHaveBeenCalledExactlyOnceWith("conversation-1");
    expect(container.querySelectorAll(".ai-message")).toHaveLength(30);
    expect(screen.queryByText("Conversation message 5")).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: i18n.t("ai:input"),
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Draft edited while reading history");
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it.each(["pending", "streaming", "failed", "interrupted"] as const)(
    "does not label a non-reusable %s reply as cleared source data",
    async (status) => {
      nativeSession.messages = [
        {
          id: "reply-1",
          role: "assistant",
          content: "Partial model reply",
          createdAt: 1000,
          status,
          requestId: "run-1",
          modelLabel: null,
          sourceCategories: ["resources"],
          reusableInContext: false,
          usage: null,
        },
      ];
      render(<AiAssistant />);
      await screen.findByText("Partial model reply");
      expect(
        screen.queryByText("源数据已清除，此消息不会再次作为上下文发送。"),
      ).toBeNull();
      if (status === "failed") expect(screen.getByText("失败")).toBeTruthy();
      if (status === "interrupted")
        expect(screen.getByText("已中断")).toBeTruthy();
    },
  );
  it.each(["assistant", "user"] as const)(
    "labels an invalidated completed %s message as cleared source data",
    async (role) => {
      nativeSession.messages = [
        {
          id: "invalidated-message",
          role,
          content: "Previously completed message",
          createdAt: 1000,
          status: "complete",
          requestId: "run-1",
          modelLabel: null,
          sourceCategories: ["resources"],
          reusableInContext: false,
          usage: null,
        },
      ];
      render(<AiAssistant />);
      await screen.findByText("源数据已清除，此消息不会再次作为上下文发送。");
    },
  );
  it("restores the conversation's model without asking to select the new default or generating a reply", async () => {
    render(<AiAssistant />);
    await loaded();
    expect(screen.queryByLabelText("模型 ID")).toBeNull();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("shows an exact optional preview without sending and deduplicates a double click on its send button", async () => {
    render(<AiAssistant />);
    await loaded();
    compose();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:preview") }));
    await screen.findByRole("region", { name: "本次发送内容" });
    expect(api.saveDraft).toHaveBeenCalledWith(
      "conversation-1",
      1,
      "现在怎么样？",
    );
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.getByText(/CPU 30%/)).toBeTruthy();
    const send = screen
      .getAllByRole("button", { name: "发送" })
      .find((button) => !(button as HTMLButtonElement).disabled)!;
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start).toHaveBeenCalledWith(
      "prepared-1",
      expect.any(String),
      1,
    );
  });
  it.each([false, true])("Enter sends immediately with selected device data in compact=%s without a review step", async (compact) => {
    render(<AiAssistant compact={compact} />);
    await loaded();
    expect(api.start).not.toHaveBeenCalled();
    compose();
    const input = screen.getByRole("textbox", { name: "给 Robin 的消息" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ includeContext: true, expectedConnectionRevision: 1 }));
    expect(screen.queryByRole("region", { name: "本次发送内容" })).toBeNull();
    expect(api.saveDraft).toHaveBeenCalled();
  });
  it("respects an unchecked context option without adding a confirmation step", async () => {
    render(<AiAssistant />);
    await loaded();
    fireEvent.click(screen.getByRole("checkbox", { name: "附带所选设备上下文" }));
    compose();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ includeContext: false }));
  });
  it("sends user-provided addresses directly without a content approval step", async () => {
    render(<AiAssistant />);
    await loaded();
    compose("解释 192.0.2.42 的连接问题");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "给 Robin 的消息" }), { key: "Enter" });
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ text: "解释 192.0.2.42 的连接问题" }));
    expect(screen.queryByRole("region", { name: "本次发送内容" })).toBeNull();
  });
  it("never sends merely because a configured conversation opens", async () => {
    render(<AiAssistant />);
    await loaded();
    expect(api.start).not.toHaveBeenCalled();
    compose();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start).toHaveBeenCalledWith(
      "prepared-1",
      expect.any(String),
      1,
    );
  });
  it("shows the exact user text only when the optional preview is opened", async () => {
    const sensitiveValues = [
      "/Users/example/private.txt",
      "192.0.2.42",
      "token-test-not-real",
    ];
    preview.preview = sensitiveValues.join("\n");
    render(<AiAssistant />);
    await loaded();
    compose();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:preview") }));
    const review = await screen.findByRole("region", {
      name: "本次发送内容",
    });
    for (const value of sensitiveValues) {
      expect(review.textContent?.split(value)).toHaveLength(2);
    }
    fireEvent.click(within(review).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  });
  it("lets the user cancel the optional review and return to the saved draft", async () => {
    render(<AiAssistant />);
    await loaded();
    compose();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("ai:preview") }));
    const review = await screen.findByRole("region", {
      name: "本次发送内容",
    });
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(within(review).getByRole("button", { name: "取消" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "给 Robin 的消息",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("现在怎么样？");
    expect(api.start).not.toHaveBeenCalled();
  });
  it("adopts the new native session after changing a model and prepares subsequent messages with its new id", async () => {
    nativeSession.messages = [
      {
        id: "old-message",
        role: "user",
        content: "History that belongs only to the previous model",
        createdAt: 1000,
        status: "complete",
        requestId: "old-run",
        modelLabel: null,
        sourceCategories: [],
        reusableInContext: true,
        usage: null,
      },
    ];
    const old = clone(nativeSession);
    api.selectModel.mockImplementationOnce(
      async (_id, _revision, selection) => {
        nativeSession = {
          ...nativeSession,
          id: "conversation-new-model",
          title: "新模型会话",
          revision: 1,
          draftRevision: 1,
          draftText: "",
          selectedModel: selection,
          messages: [],
        };
        return clone(nativeSession);
      },
    );
    api.listSessions.mockImplementation(async () => ({
      sessions: [
        clone(nativeSession),
        ...(nativeSession.id !== old.id ? [old] : []),
      ],
      hasMore: false,
    }));
    api.prepare.mockImplementation(async () => ({
      ...clone(preview),
      sessionId: nativeSession.id,
      selection: nativeSession.selectedModel,
      history: [],
    }));
    const onSessionReady = vi.fn();
    render(<AiAssistant onSessionReady={onSessionReady} />);
    await loaded();
    expect(screen.getByText(old.messages[0]!.content)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.change(screen.getByLabelText("模型连接"), {
      target: { value: "cloud" },
    });
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "different-model" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("ai:applyModel") }),
    );
    await waitFor(() =>
      expect(onSessionReady).toHaveBeenLastCalledWith("conversation-new-model"),
    );
    expect(api.selectModel).toHaveBeenCalledWith("conversation-1", 1, {
      connectionId: "cloud",
      modelId: "different-model",
    });
    expect(screen.queryByText(old.messages[0]!.content)).toBeNull();
    expect(
      screen.getByRole("button", { name: "切换模型" }).textContent,
    ).toContain("different-model");
    compose();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "conversation-new-model",
        text: "现在怎么样？",
      }),
    );
    expect(api.start).toHaveBeenCalledOnce();
  });
  it("does not send or hide when Enter or Escape confirms IME composition", async () => {
    const onHide = vi.fn();
    render(<AiAssistant compact onHide={onHide} />);
    await loaded();
    compose();
    const input = screen.getByRole("textbox", { name: "给 Robin 的消息" });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(api.prepare).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(api.prepare).not.toHaveBeenCalled();
  });
  it("keeps the draft and refuses handoff if saving fails", async () => {
    const onExpand = vi.fn();
    api.saveDraft.mockRejectedValue({
      code: "storage_error",
      message: "保存失败",
    });
    render(<AiAssistant compact onExpand={onExpand} />);
    await loaded();
    compose();
    fireEvent.click(screen.getByRole("button", { name: "在主窗口继续" }));
    await screen.findByRole("alert");
    expect(onExpand).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("textbox", {
          name: "给 Robin 的消息",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("现在怎么样？");
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("flushes a draft before handoff and never cancels a run just because the bubble closes", async () => {
    const onExpand = vi.fn();
    const onHide = vi.fn();
    render(<AiAssistant compact onExpand={onExpand} onHide={onHide} />);
    await loaded();
    compose();
    fireEvent.click(screen.getByRole("button", { name: "在主窗口继续" }));
    await waitFor(() =>
      expect(onExpand).toHaveBeenCalledWith("conversation-1", {
        before: null,
        anchorId: null,
        anchorOffset: 0,
      }),
    );
    expect(api.saveDraft).toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起对话" }));
    await waitFor(() => expect(onHide).toHaveBeenCalledOnce());
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it("requires confirmation before clearing, retains model settings, and does not recreate a deleted conversation", async () => {
    render(<AiAssistant />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "清空全部对话" }));
    expect(api.clearConversations).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(dialog.querySelector("button:last-child")!);
    await waitFor(() => expect(api.clearConversations).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("旧会话")).toBeNull());
    expect(api.createSession).not.toHaveBeenCalled();
    expect(nativeState.settings.defaultModel?.modelId).toBe("new-default");
    listeners.forEach((callback) => callback());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(api.createSession).not.toHaveBeenCalled();
  });
  it("opens a contextual conversation once in StrictMode and preserves its input", async () => {
    const contextRequest = {
      id: "incident-open-1",
      scenario: "history" as const,
      incidentId: "incident-1",
      prompt: "请解释这次异常",
    };
    render(
      <StrictMode>
        <AiAssistant contextRequest={contextRequest} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "给 Robin 的消息",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("请解释这次异常"),
    );
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("restores the native incident and time scope when another window opens the same session", async () => {
    nativeSession = {
      ...nativeSession,
      scenario: "history",
      incidentId: "incident-7",
      fromMs: 1000,
      toMs: 5000,
    };
    render(<AiAssistant sessionId="conversation-1" />);
    await loaded();
    compose();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(api.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: "history",
          incidentId: "incident-7",
          fromMs: 1000,
          toMs: 5000,
        }),
      ),
    );
    expect(api.setSessionContext).not.toHaveBeenCalled();
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  });
  it("persists a changed context scope before a main-window handoff", async () => {
    const onExpand = vi.fn();
    render(<AiAssistant compact onExpand={onExpand} />);
    await loaded();
    fireEvent.change(screen.getByRole("combobox", { name: "设备上下文" }), {
      target: { value: "network" },
    });
    await waitFor(() =>
      expect(api.setSessionContext).toHaveBeenCalledWith("conversation-1", 1, {
        scenario: "network",
        incidentId: null,
        fromMs: null,
        toMs: null,
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "在主窗口继续",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "在主窗口继续" }));
    await waitFor(() =>
      expect(onExpand).toHaveBeenCalledWith("conversation-1", {
        before: null,
        anchorId: null,
        anchorOffset: 0,
      }),
    );
    expect(nativeSession.scenario).toBe("network");
    expect(api.start).not.toHaveBeenCalled();
  });
  it("flushes the draft when native code hides the bubble", async () => {
    let visibleChanged: ((visible: boolean) => void) | undefined;
    api.onVisibility.mockImplementation(
      async (callback: (visible: boolean) => void) => {
        visibleChanged = callback;
        return () => {};
      },
    );
    render(<AiAssistant compact />);
    await loaded();
    compose();
    await act(async () => {
      visibleChanged?.(false);
    });
    expect(api.saveDraft).toHaveBeenCalledWith(
      "conversation-1",
      1,
      "现在怎么样？",
    );
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it("keeps the original draft revision across a remote change event until the user explicitly overwrites", async () => {
    render(<AiAssistant />);
    await loaded();
    compose();
    nativeSession = {
      ...nativeSession,
      draftText: "另一窗口的草稿",
      draftRevision: 2,
    };
    await act(async () => {
      listeners.forEach((callback) => callback());
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await screen.findByRole("button", { name: "用我的草稿覆盖已保存版本" });
    expect(api.saveDraft).toHaveBeenLastCalledWith(
      "conversation-1",
      1,
      "现在怎么样？",
    );
    expect(nativeSession.draftText).toBe("另一窗口的草稿");
    expect(
      (
        screen.getByRole("textbox", {
          name: "给 Robin 的消息",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("现在怎么样？");
    fireEvent.change(screen.getByRole("textbox", { name: "给 Robin 的消息" }), {
      target: { value: "继续编辑我的草稿" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(nativeSession.draftText).toBe("另一窗口的草稿");
    fireEvent.click(
      screen.getByRole("button", { name: "用我的草稿覆盖已保存版本" }),
    );
    await waitFor(() =>
      expect(api.saveDraft).toHaveBeenLastCalledWith(
        "conversation-1",
        2,
        "继续编辑我的草稿",
      ),
    );
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(nativeSession.draftText).toBe("继续编辑我的草稿");
  });
  it("can load the saved remote draft after a natural cross-window conflict without writing local text", async () => {
    render(<AiAssistant />);
    await loaded();
    compose();
    nativeSession = {
      ...nativeSession,
      draftText: "另一窗口的草稿",
      draftRevision: 2,
    };
    await act(async () => {
      listeners.forEach((callback) => callback());
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用已保存的草稿" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "给 Robin 的消息",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("另一窗口的草稿"),
    );
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.saveDraft).toHaveBeenCalledWith(
      "conversation-1",
      1,
      "现在怎么样？",
    );
    expect(nativeSession.draftRevision).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each([
    ["unauthorized", "模型服务拒绝了凭据，请更新 API Key"],
    ["rate_limited", "模型服务请求过多，请稍后重试"],
    ["timeout", "等待模型服务回复超时"],
  ])(
    "shows asynchronous %s failures for the current conversation only",
    async (code, message) => {
        api.start.mockImplementation(async (_preparationId, submissionId) => {
        nativeState.activeRun = {
          requestId: "run-pending",
          sessionId: nativeSession.id,
          submissionId,
          state: "pending",
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
        };
        nativeSession.draftText = "";
        nativeSession.draftRevision += 1;
        return clone(nativeState.activeRun);
      });
      render(<AiAssistant />);
      await loaded();
      compose();
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await screen.findByRole("button", { name: "停止生成" });
      expect(screen.queryByRole("alert")).toBeNull();
      nativeState.activeRun = {
        ...nativeState.activeRun!,
        state: "failed",
        finishedAt: Date.now(),
        error: { code, message },
      };
      await act(async () => {
        listeners.forEach((callback) => callback());
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await screen.findByRole("alert");
      expect(screen.getByText(message)).toBeTruthy();
      nativeState.activeRun.sessionId = "another-conversation";
      await act(async () => {
        listeners.forEach((callback) => callback());
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.queryByText(message)).toBeNull();
    },
  );
  it("ignores late older snapshots after receiving newer streamed content", async () => {
    render(<AiAssistant />);
    await loaded();
    let resolveOlder: ((session: AiSession) => void) | undefined;
    const older = { ...clone(nativeSession), revision: 2 };
    api.getSession.mockImplementationOnce(
      () =>
        new Promise<AiSession>((resolve) => {
          resolveOlder = resolve;
        }),
    );
    await act(async () => {
      listeners.forEach((callback) => callback());
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    nativeSession = {
      ...nativeSession,
      revision: 3,
      messages: [
        {
          id: "answer-new",
          role: "assistant",
          content: "较新的流式内容",
          createdAt: 2000,
          status: "streaming",
          requestId: "run-1",
          modelLabel: "model",
          sourceCategories: [],
          reusableInContext: true,
          usage: null,
        },
      ],
    };
    await act(async () => {
      listeners.forEach((callback) => callback());
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await screen.findByText("较新的流式内容");
    await act(async () => {
      resolveOlder?.(older);
    });
    expect(screen.getByText("较新的流式内容")).toBeTruthy();
  });
  it("binds the first configured model to an empty setup conversation once and then keeps it", async () => {
    nativeSession.selectedModel = null;
    nativeState.settings.enabled = false;
    nativeState.settings.defaultModel = null;
    render(<AiAssistant />);
    await waitFor(() => expect(api.getSession).toHaveBeenCalled());
    expect(api.selectModel).not.toHaveBeenCalled();
    nativeState.settings.enabled = true;
    nativeState.settings.defaultModel = {
      connectionId: "local",
      modelId: "first-configured-model",
    };
    await act(async () => {
      listeners.forEach((callback) => callback());
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await waitFor(() =>
      expect(api.selectModel).toHaveBeenCalledWith("conversation-1", 1, {
        connectionId: "local",
        modelId: "first-configured-model",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "切换模型" }).textContent,
      ).toContain("first-configured-model"),
    );
    nativeState.settings.defaultModel = {
      connectionId: "cloud",
      modelId: "later-default",
    };
    await act(async () => {
      listeners.forEach((callback) => callback());
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(api.selectModel).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });
});
