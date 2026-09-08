export type AiProtocol =
  | "ollama_native"
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages";
export type AiScenario = "current_status" | "network" | "history";
export interface AiContextRequest {
  id: string;
  scenario: AiScenario;
  incidentId?: string;
  prompt?: string;
  fromMs?: number;
  toMs?: number;
}
export interface AiSessionContext {
  scenario: AiScenario;
  incidentId: string | null;
  fromMs: number | null;
  toMs: number | null;
}
export interface ModelSelection {
  connectionId: string;
  modelId: string;
}
export interface ConnectionProfile {
  id: string;
  revision: number;
  name: string;
  protocol: AiProtocol;
  apiBaseUrl: string;
  authKind: "none" | "bearer" | "api_key" | "custom_header";
  networkPolicy: "loopback" | "public" | "private";
  proxyUrl: string | null;
  proxyNetworkPolicy: "loopback" | "public" | "private" | null;
  timeoutSeconds: number;
  maxOutputTokens: number;
  stream: boolean;
  authHeaderName: string | null;
  anthropicWorkspaceId: string | null;
  chatTokenLimitParameter: "auto" | "max_tokens" | "max_completion_tokens";
  credentialStatus: "missing" | "saved" | "temporary" | "not_required";
  proxyCredentialStatus: "missing" | "saved" | "temporary" | "not_required";
}
export type SaveConnectionInput = Omit<
  ConnectionProfile,
  "id" | "revision" | "credentialStatus" | "proxyCredentialStatus"
> & { id?: string; expectedRevision?: number };
export interface AiSettings {
  enabled: boolean;
  defaultModel: ModelSelection | null;
  storageBudgetBytes: number;
  localConnectionsOnly: boolean;
}
export interface AiError {
  code: string;
  message: string;
}
export type AiRunStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "cancelled"
  | "interrupted"
  | "failed";
export interface AnalysisRun {
  requestId: string;
  sessionId: string;
  submissionId: string;
  state: AiRunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: AiError | null;
}
export interface AiState {
  capabilities: CapabilityRecord[];
  settings: AiSettings;
  connections: ConnectionProfile[];
  activeRun: AnalysisRun | null;
  storageBytes: number;
  storageWarning: boolean;
  requestEpoch: number;
}
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface CapabilityRecord {
  connectionId: string;
  profileRevision: number;
  modelId: string;
  checkedAt: number;
  kind: "address" | "discovery" | "text";
  status: "verified" | "failed" | "expired";
}
export interface EvidenceReference {
  id: string;
  label: string;
  value: string;
  unit: string | null;
}
export interface ValidatedResult {
  result: {
    summary: string;
    findings: {
      statement: string;
      evidenceIds: string[];
      kind: "observation" | "hypothesis";
    }[];
    unknowns: string[];
    nextSteps: { target: AiScenario; evidenceIds: string[] }[];
  };
  evidence: EvidenceReference[];
}
export interface AiMessage {
  toolSteps?: AiToolStep[];
  validatedResult?: ValidatedResult | null;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: AiRunStatus;
  requestId: string | null;
  modelLabel: string | null;
  sourceCategories: string[];
  reusableInContext: boolean;
  usage: TokenUsage | null;
  contextText?: string | null;
}
export interface AiToolStep {
  actionsExpiresAt?: number | null;
  id: string;
  name: string;
  state: "running" | "awaiting_confirmation" | "complete" | "failed" | "cancelled" | "interrupted";
  startedAt: number;
  finishedAt: number | null;
  result: string | null;
  error: AiError | null;
  confirmation: {
    action: "request_close" | "force_kill" | "trash";
    targets: string[];
    detail: string;
    expiresAt: number;
  } | null;
}
export interface AiSessionSummary extends AiSessionContext {
  id: string;
  title: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  temporary: boolean;
  selectedModel: ModelSelection | null;
  draftText: string;
  draftRevision: number;
  storageStatus: "saved" | "temporary" | "error";
  sourceCategories: string[];
}
export interface AiSession extends AiSessionSummary {
  messages: AiMessage[];
  totalMessages?: number;
  messageOffset?: number;
  hasOlderMessages?: boolean;
}
export interface AiMessagePosition {
  before: number | null;
  anchorId: string | null;
  anchorOffset: number;
}
export interface PreparedAnalysis {
  processingLocation?: "remote" | "unknown";
  connectionLocation?: "loopback" | "public" | "private";
  id: string;
  sessionId: string;
  sessionRevision: number;
  expiresAt: number;
  selection: ModelSelection;
  connectionName: string;
  endpoint: string;
  protocol: AiProtocol;
  preview: string;
  userText: string;
  scenario: AiScenario;
  sourceCategories: string[];
  coverage: string[];
  requestEpoch: number;
  history: { role: string; content: string }[];
  proxyUrl: string | null;
}
export interface ModelInfo {
  id: string;
  name: string;
  processingLocation?: "remote" | "unknown";
}
export function isRunActive(run: AnalysisRun | null | undefined): boolean {
  return run?.state === "pending" || run?.state === "streaming";
}
export function aiError(error: unknown): AiError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  )
    return { code: String(error.code), message: String(error.message) };
  return {
    code: "unavailable",
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "AI service unavailable",
  };
}
