import type { CapabilityActionInput } from "../capabilities/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { aiError } from "./types";
import type {
  AiSettings,
  AiState,
  ConnectionProfile,
  SaveConnectionInput,
  ModelSelection,
  ModelInfo,
  TokenUsage,
  AiSession,
  AiSessionSummary,
  AiSessionContext,
  AiScenario,
  PreparedAnalysis,
  AnalysisRun,
} from "./types";

export const aiApi = {
  openHelp: (
    topic:
      | "ollama"
      | "openai"
      | "anthropic"
      | "deepseek"
      | "bailian"
      | "openai-data",
  ) => invoke<void>("ai_open_help", { topic }),
  getState: () => invoke<AiState>("ai_get_state"),
  updateSettings: (input: AiSettings) =>
    invoke<AiState>("ai_update_settings", { input }),
  saveConnection: (input: SaveConnectionInput) =>
    invoke<ConnectionProfile>("ai_save_connection", { input }),
  deleteConnection: (connectionId: string) =>
    invoke<void>("ai_delete_connection", { connectionId }),
  setCredential: (connectionId: string, secret: string, temporary: boolean) =>
    invoke<void>("ai_set_credential", {
      input: { connectionId, secret, temporary },
    }),
  deleteCredential: (connectionId: string) =>
    invoke<void>("ai_delete_credential", { connectionId }),
  setProxyCredential: (
    connectionId: string,
    username: string,
    password: string,
    temporary: boolean,
  ) =>
    invoke<void>("ai_set_proxy_credential", {
      input: { connectionId, username, password, temporary },
    }),
  deleteProxyCredential: (connectionId: string) =>
    invoke<void>("ai_delete_proxy_credential", { connectionId }),
  listModels: (connectionId: string) =>
    invoke<ModelInfo[]>("ai_list_models", { connectionId }),
  testModel: (selection: ModelSelection) =>
    invoke<{
      text: string;
      usage: TokenUsage | null;
      reportedModel: string | null;
    }>("ai_test_model", { selection }),
  createSession: (
    input: {
      title?: string;
      temporary?: boolean;
      selectedModel?: ModelSelection;
      scenario?: AiScenario;
      incidentId?: string;
      fromMs?: number;
      toMs?: number;
    } = {},
  ) => invoke<AiSession>("ai_create_session", { input }),
  listSessions: (offset = 0, limit = 50) =>
    invoke<{ sessions: AiSessionSummary[]; hasMore: boolean }>(
      "ai_list_sessions",
      { offset, limit },
    ),
  getSession: (sessionId: string, before?: number) =>
    invoke<AiSession>("ai_get_session", { sessionId, before }),
  renameSession: (sessionId: string, title: string) =>
    invoke<AiSession>("ai_rename_session", { sessionId, title }),
  deleteSession: (sessionId: string) =>
    invoke<void>("ai_delete_session", { sessionId }),
  clearConversations: () => invoke<void>("ai_clear_conversations"),
  saveDraft: (sessionId: string, expectedDraftRevision: number, text: string) =>
    invoke<AiSession>("ai_save_draft", {
      input: { sessionId, expectedDraftRevision, text },
    }).catch((failure: unknown) => {
      const error = aiError(failure);
      throw error.code === "stale_state"
        ? { ...error, code: "draft_conflict" }
        : error;
    }),
  selectModel: (
    sessionId: string,
    expectedRevision: number,
    selection: ModelSelection,
  ) =>
    invoke<AiSession>("ai_select_session_model", {
      input: { sessionId, expectedRevision, selection },
    }),
  setSessionContext: (
    sessionId: string,
    expectedRevision: number,
    context: AiSessionContext,
  ) =>
    invoke<AiSession>("ai_set_session_context", {
      input: { sessionId, expectedRevision, ...context },
    }),
  prepare: (input: {
    language?: string;
    expectedConnectionRevision?: number;
    sessionId: string;
    expectedRevision: number;
    text: string;
    scenario: AiScenario;
    includeContext: boolean;
    incidentId?: string;
    fromMs?: number;
    toMs?: number;
  }) => invoke<PreparedAnalysis>("ai_prepare", { input }),
  start: (
    preparationId: string,
    submissionId: string,
    expectedSessionRevision: number,
  ) =>
    invoke<AnalysisRun>("ai_start", {
      input: {
        preparationId,
        submissionId,
        expectedSessionRevision,
      },
    }),
  runCapabilityAction: (input: CapabilityActionInput) => invoke<AnalysisRun>("ai_run_capability_action", { input }),
  cancel: (requestId: string) => invoke<void>("ai_cancel", { requestId }),
  resolveToolConfirmation: (requestId: string, stepId: string, approved: boolean) =>
    invoke<void>("ai_resolve_tool_confirmation", { requestId, stepId, approved }),
  onChange: (callback: () => void) => listen("ai-state-changed", callback),
  onVisibility: (callback: (visible: boolean) => void) =>
    listen<boolean>("core-robin:ai-chat-visibility", ({ payload }) =>
      callback(payload),
    ),
};
