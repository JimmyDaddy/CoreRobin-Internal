import { Select } from "../Select";
import { useApplicationCapabilities } from "../../capabilities/useApplicationCapabilities";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Eye,
  History,
  Maximize2,
  MessageCircle,
  Pencil,
  Plus,
  Send,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { aiApi } from "../../ai/api";
import { endpointLabel } from "../../ai/presets";
import {
  aiError,
  isRunActive,
  type AiContextRequest,
  type AiError,
  type AiMessagePosition,
  type AiScenario,
  type AiSession,
  type AiSessionSummary,
  type ModelSelection,
  type PreparedAnalysis,
} from "../../ai/types";
import { useAiState } from "../../ai/useAiState";
import { Button } from "../Button";
import { AiConfirm } from "./AiConfirm";
import { AiErrorNotice } from "./AiErrorNotice";
import { AiResultCard } from "./AiResultCard";
import { AiToolSteps } from "./AiToolSteps";
import "../../styles/ai.css";

const AiMarkdown = lazy(async () => ({ default: (await import("./AiMarkdown")).AiMarkdown }));

export interface AiAssistantProps {
  compact?: boolean;
  sessionId?: string | null;
  scenario?: AiScenario;
  contextRequest?: AiContextRequest;
  onOpenSettings?: () => void | Promise<void>;
  onExpand?: (
    sessionId: string,
    position?: AiMessagePosition,
  ) => void | Promise<void>;
  restorePosition?: AiMessagePosition | null;
  onHide?: () => void | Promise<void>;
  onSessionReady?: (sessionId: string) => void;
  onOpenEvidenceSource?: (scenario: AiScenario) => void | Promise<void>;
}

export function AiAssistant({
  compact = false,
  sessionId,
  scenario = "current_status",
  contextRequest,
  onOpenSettings,
  onExpand,
  restorePosition,
  onHide,
  onSessionReady,
  onOpenEvidenceSource,
}: AiAssistantProps) {
  const { t, i18n } = useTranslation("ai");
  const { state, error: stateError, refresh: refreshState } = useAiState();
  const applicationCapabilities = useApplicationCapabilities();
  const [session, setSession] = useState<AiSession | null>(null);
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(!compact);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AiError | null>(null);
  const [prepared, setPrepared] = useState<PreparedAnalysis | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [activeScenario, setActiveScenario] = useState(scenario);
  const [incidentId, setIncidentId] = useState<string | undefined>();
  const [historyHours, setHistoryHours] = useState(24);
  const [fixedTimeRange, setFixedTimeRange] = useState<{
    fromMs?: number;
    toMs?: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [selection, setSelection] = useState<ModelSelection>({
    connectionId: "",
    modelId: "",
  });
  const [confirmation, setConfirmation] = useState<
    { kind: "clear" } | { kind: "session"; id: string } | null
  >(null);
  const sessionRef = useRef<AiSession | null>(null);
  const draftRef = useRef("");
  const dirtyRef = useRef(false);
  const dirtyBaseRevision = useRef<number | null>(null);
  const draftConflict = useRef<AiError | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const savePromise = useRef<Promise<void> | null>(null);
  const submissionId = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const historySequence = useRef(0);
  const messagePageSequence = useRef(0);
  const messagePageBefore = useRef<number | undefined>(undefined);
  const lastRestoration = useRef<{
    sessionId: string;
    position: AiMessagePosition;
  } | null>(null);
  const pendingRestoration = useRef<{
    sessionId: string;
    position: AiMessagePosition;
  } | null>(null);
  const suppressAutoScroll = useRef(false);
  const initialization = useRef<Promise<AiSession> | null>(null);
  const initialModelBinding = useRef<string | null>(null);
  const contextSeen = useRef<string | undefined>(undefined);
  const contextInitialization = useRef<{
    id: string;
    promise: Promise<AiSession>;
  } | null>(null);
  const readyCallback = useRef(onSessionReady);
  readyCallback.current = onSessionReady;
  useEffect(() => {
    const loaded = sessionRef.current;
    if (loaded && (!sessionId || sessionId === loaded.id))
      onSessionReady?.(loaded.id);
  }, [onSessionReady, sessionId]);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const messagesViewport = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const refreshHistory = useCallback(async (offset = 0) => {
    const sequence = ++historySequence.current;
    const result = await aiApi.listSessions(offset);
    if (mountedRef.current && sequence === historySequence.current) {
      setSessions((previous) =>
        offset
          ? [
              ...previous,
              ...result.sessions.filter(
                (item) => !previous.some((old) => old.id === item.id),
              ),
            ]
          : result.sessions,
      );
      setHasMore(result.hasMore);
    }
  }, []);
  const adoptSession = useCallback((next: AiSession, switchSession = false, restoreMessages = false) => {
    if (!mountedRef.current) return;
    const current = sessionRef.current;
    if (!switchSession && current && current.id !== next.id) return;
    if (
      !switchSession &&
      current &&
      (next.revision < current.revision ||
        next.draftRevision < current.draftRevision)
    )
      return;
    // Saving a draft does not change message content. Preserve that array so
    // a draft acknowledgement cannot scroll the conversation during a click
    // on an older result card. Different message pages still replace it.
    const adopted = !switchSession && !restoreMessages && !pendingRestoration.current && current && current.id === next.id && current.revision === next.revision
      && current.messages.length === next.messages.length
      && current.messages[0]?.id === next.messages[0]?.id
      && current.messages[current.messages.length - 1]?.id === next.messages[next.messages.length - 1]?.id
      ? { ...next, messages: current.messages } : next;
    sessionRef.current = adopted;
    setSession(adopted);
    setActiveScenario(next.scenario ?? "current_status");
    setIncidentId(next.incidentId ?? undefined);
    setFixedTimeRange(
      next.fromMs != null || next.toMs != null
        ? { fromMs: next.fromMs ?? undefined, toMs: next.toMs ?? undefined }
        : null,
    );
    if (switchSession || !dirtyRef.current) {
      draftRef.current = next.draftText;
      dirtyRef.current = false;
      dirtyBaseRevision.current = null;
      draftConflict.current = null;
      setDraft(next.draftText);
      setDirty(false);
    }
    if (switchSession) {
      suppressAutoScroll.current = false;
      pendingRestoration.current = null;
      messagePageBefore.current = undefined;
      ++messagePageSequence.current;
      setPrepared(null);
      submissionId.current = null;
      setModelOpen(false);
      setError(null);
      setSelection(next.selectedModel ?? { connectionId: "", modelId: "" });
    }
  }, []);
  const refreshSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = current.id;
    const pageSequence = messagePageSequence.current;
    const before = messagePageBefore.current;
    try {
      const next =
        before === undefined
          ? await aiApi.getSession(id)
          : await aiApi.getSession(id, before);
      if (
        sessionRef.current?.id === id &&
        pageSequence === messagePageSequence.current &&
        before === messagePageBefore.current
      )
        adoptSession(next);
    } catch (failure) {
      const problem = aiError(failure);
      if (
        sessionRef.current?.id === id &&
        /not_found|deleted/.test(problem.code)
      ) {
        sessionRef.current = null;
        setSession(null);
        draftRef.current = "";
        dirtyRef.current = false;
        dirtyBaseRevision.current = null;
        draftConflict.current = null;
        setDraft("");
        setDirty(false);
        setPrepared(null);
      } else throw failure;
    }
  }, [adoptSession]);
  useEffect(() => {
    if (!state || !session || session.selectedModel || session.messages.length)
      return;
    const selection = state.settings.defaultModel;
    if (!selection) return;
    const binding = `${session.id}:${session.revision}:${selection.connectionId}:${selection.modelId}`;
    if (initialModelBinding.current === binding) return;
    initialModelBinding.current = binding;
    // A conversation opened before first-time setup has no model yet. Bind its
    // first configured default once, without changing an existing model choice.
    void aiApi
      .selectModel(session.id, session.revision, selection)
      .then((next) => {
        adoptSession(next);
      })
      .catch((failure: unknown) => {
        if (!mountedRef.current) return;
        const problem = aiError(failure);
        if (problem.code === "stale_state" || problem.code === "busy")
          void refreshSession().catch(() => {});
        else setError(problem);
      });
  }, [state, session, adoptSession, refreshSession]);
  const flushDraft = useCallback(async () => {
    if (savePromise.current) await savePromise.current;
    if (!dirtyRef.current || !sessionRef.current) return;
    if (draftConflict.current) throw draftConflict.current;
    const work = (async () => {
      while (dirtyRef.current && sessionRef.current) {
        const current = sessionRef.current;
        const text = draftRef.current;
        let saved: AiSession;
        try {
          saved = await aiApi.saveDraft(
            current.id,
            dirtyBaseRevision.current ?? current.draftRevision,
            text,
          );
        } catch (failure) {
          const problem = aiError(failure);
          if (problem.code === "draft_conflict")
            draftConflict.current = problem;
          throw failure;
        }
        if (sessionRef.current?.id !== current.id) return;
        // Only our acknowledged save can advance the base of additional local edits.
        // Cross-window refreshes must never silently rebase an unsaved local draft.
        dirtyBaseRevision.current = saved.draftRevision;
        if (draftRef.current === text) {
          dirtyRef.current = false;
          dirtyBaseRevision.current = null;
          if (mountedRef.current) setDirty(false);
        }
        // Saving a draft returns the newest page. Keep the current historical page
        // only while its message revision is unchanged; never retain cleared content.
        adoptSession(
          messagePageBefore.current !== undefined &&
            saved.revision === current.revision
            ? {
                ...saved,
                messages: current.messages,
                messageOffset: current.messageOffset,
                hasOlderMessages: current.hasOlderMessages,
              }
            : saved,
        );
        if (
          !dirtyRef.current &&
          sessionRef.current.draftRevision > saved.draftRevision
        )
          adoptSession(sessionRef.current);
      }
    })();
    savePromise.current = work;
    try {
      await work;
    } finally {
      if (savePromise.current === work) savePromise.current = null;
    }
  }, [adoptSession]);
  const changeDraft = (value: string) => {
    if (!dirtyRef.current)
      dirtyBaseRevision.current = sessionRef.current?.draftRevision ?? null;
    draftRef.current = value;
    dirtyRef.current = true;
    setDraft(value);
    setDirty(true);
    setPrepared(null);
    submissionId.current = null;
  };
  const perform = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (mountedRef.current) setError(aiError(failure));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };
  const openSession = async (id: string) => {
    await flushDraft();
    const sequence = ++loadSequence.current;
    const next = await aiApi.getSession(id);
    if (sequence !== loadSequence.current || !mountedRef.current) return;
    adoptSession(next, true);
    if (compact) setHistoryOpen(false);
    readyCallback.current?.(next.id);
  };
  const loadMessagePage = async (before?: number) => {
    const current = sessionRef.current;
    if (!current) return;
    const sequence = ++messagePageSequence.current;
    await flushDraft();
    if (sessionRef.current?.id !== current.id) return;
    const next =
      before === undefined
        ? await aiApi.getSession(current.id)
        : await aiApi.getSession(current.id, before);
    if (
      sequence !== messagePageSequence.current ||
      sessionRef.current?.id !== current.id ||
      !mountedRef.current
    )
      return;
    messagePageBefore.current = before;
    suppressAutoScroll.current = false;
    pendingRestoration.current = null;
    adoptSession(next);
  };
  const captureMessagePosition = (): AiMessagePosition => {
    const viewport = messagesViewport.current;
    const bounds = viewport?.getBoundingClientRect();
    const anchor =
      viewport && bounds
        ? [
            ...viewport.querySelectorAll<HTMLElement>("[data-ai-message-id]"),
          ].find((message) => {
            const rect = message.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          })
        : undefined;
    return {
      before: messagePageBefore.current ?? null,
      anchorId: anchor?.dataset.aiMessageId ?? null,
      anchorOffset:
        anchor && bounds ? anchor.getBoundingClientRect().top - bounds.top : 0,
    };
  };
  const newSession = async (temporary = false) => {
    await flushDraft();
    ++loadSequence.current;
    const next = await aiApi.createSession({
      temporary,
      scenario: activeScenario,
    });
    adoptSession(next, true);
    setIncidentId(undefined);
    setFixedTimeRange(null);
    if (compact) setHistoryOpen(false);
    readyCallback.current?.(next.id);
    await refreshHistory();
  };
  const changeScenario = async (nextScenario: AiScenario) => {
    await flushDraft();
    const current = sessionRef.current;
    if (!current) return;
    const next = await aiApi.setSessionContext(current.id, current.revision, {
      scenario: nextScenario,
      incidentId: null,
      fromMs: null,
      toMs: null,
    });
    adoptSession(next);
    setPrepared(null);
  };
  useEffect(() => {
    mountedRef.current = true;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void aiApi
      .onChange(() => {
        if (timer === undefined && !stopped)
          timer = setTimeout(() => {
            timer = undefined;
            if (!stopped) {
              void refreshSession().catch((failure) =>
                setError(aiError(failure)),
              );
              void refreshHistory().catch(() => {});
            }
          }, 80);
      })
      .then((stop) => {
        if (stopped) stop();
        else {
          unlisten = stop;
          void refreshSession().catch(() => {});
        }
      })
      .catch((failure) => setError(aiError(failure)));
    void refreshHistory().catch((failure) => {
      if (!stopped) setError(aiError(failure));
    });
    return () => {
      stopped = true;
      mountedRef.current = false;
      ++loadSequence.current;
      ++historySequence.current;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [refreshHistory, refreshSession]);
  useEffect(() => {
    let stopped = false;
    const sequence = ++loadSequence.current;
    const load = async () => {
      if (contextRequest && contextSeen.current !== contextRequest.id) {
        await flushDraft();
        if (contextInitialization.current?.id !== contextRequest.id)
          contextInitialization.current = {
            id: contextRequest.id,
            promise: aiApi.createSession({
              scenario: contextRequest.scenario,
              incidentId: contextRequest.incidentId,
              fromMs: contextRequest.fromMs,
              toMs: contextRequest.toMs,
            }),
          };
        const next = await contextInitialization.current.promise;
        if (stopped || sequence !== loadSequence.current) return;
        contextSeen.current = contextRequest.id;
        adoptSession(next, true);
        if (contextRequest.prompt) {
          draftRef.current = contextRequest.prompt;
          dirtyRef.current = true;
          dirtyBaseRevision.current = next.draftRevision;
          setDraft(contextRequest.prompt);
          setDirty(true);
        }
        readyCallback.current?.(next.id);
        await refreshHistory();
        return;
      }
      if (sessionId) {
        const needsRestoration =
          restorePosition &&
          (lastRestoration.current?.sessionId !== sessionId ||
            lastRestoration.current.position !== restorePosition);
        if (sessionRef.current?.id === sessionId && !needsRestoration) {
          readyCallback.current?.(sessionId);
          return;
        }
        await flushDraft();
        ++messagePageSequence.current;
        const before = needsRestoration
          ? (restorePosition.before ?? undefined)
          : undefined;
        const next =
          before === undefined
            ? await aiApi.getSession(sessionId)
            : await aiApi.getSession(sessionId, before);
        if (!stopped && sequence === loadSequence.current) {
          adoptSession(next, sessionRef.current?.id !== next.id, Boolean(needsRestoration));
          messagePageBefore.current = before;
          if (needsRestoration) {
            lastRestoration.current = { sessionId, position: restorePosition };
            pendingRestoration.current = {
              sessionId,
              position: restorePosition,
            };
            suppressAutoScroll.current = true;
          }
          readyCallback.current?.(next.id);
        }
        return;
      }
      if (sessionRef.current) return;
      if (!initialization.current)
        initialization.current = aiApi
          .listSessions(0, 1)
          .then(async ({ sessions: latest }) =>
            latest[0]
              ? aiApi.getSession(latest[0].id)
              : aiApi.createSession({ scenario }),
          );
      const next = await initialization.current;
      if (!stopped && sequence === loadSequence.current) {
        adoptSession(next, true);
        readyCallback.current?.(next.id);
        await refreshHistory();
      }
    };
    void load().catch((failure) => {
      if (!stopped) {
        initialization.current = null;
        setError(aiError(failure));
      }
    });
    return () => {
      stopped = true;
    };
  }, [
    sessionId,
    restorePosition,
    contextRequest,
    scenario,
    adoptSession,
    flushDraft,
    refreshHistory,
  ]);
  useEffect(() => {
    if (!dirty || busy) return;
    const timer = setTimeout(() => {
      void flushDraft().catch((failure) => {
        if (mountedRef.current) setError(aiError(failure));
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, dirty, busy, flushDraft]);
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    const flush = () => {
      void flushDraft().catch((failure) => {
        if (!stopped) setError(aiError(failure));
      });
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", flush);
    void aiApi
      .onVisibility((visible) => {
        if (!visible) flush();
      })
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", flush);
      unlisten?.();
    };
  }, [flushDraft]);
  const revealActiveConfirmation = useCallback(() => {
    if (!suppressAutoScroll.current) messagesViewport.current?.querySelector<HTMLElement>(".ai-tool-step--awaiting_confirmation")?.scrollIntoView?.({ block: "nearest" });
  }, []);
  useLayoutEffect(() => {
    const restoration = pendingRestoration.current;
    const viewport = messagesViewport.current;
    if (restoration && restoration.sessionId === session?.id && viewport) {
      const anchor = [
        ...viewport.querySelectorAll<HTMLElement>("[data-ai-message-id]"),
      ].find(
        (message) =>
          message.dataset.aiMessageId === restoration.position.anchorId,
      );
      if (anchor) {
        const offset = Number.isFinite(restoration.position.anchorOffset)
          ? restoration.position.anchorOffset
          : 0;
        viewport.scrollTop +=
          anchor.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          offset;
      } else viewport.scrollTop = 0;
      pendingRestoration.current = null;
      return;
    }
    if (!suppressAutoScroll.current) {
      const confirmation = viewport?.querySelector<HTMLElement>(".ai-tool-step--awaiting_confirmation");
      (confirmation ?? messagesEnd.current)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [session?.id, session?.messages]);
  useEffect(() => {
    if (
      prepared &&
      state &&
      prepared.requestEpoch !== state.requestEpoch
    )
      setPrepared(null);
  }, [prepared, state]);
  const startPrepared = async (preview: PreparedAnalysis) => {
    const stableSubmission = submissionId.current ?? crypto.randomUUID();
    submissionId.current = stableSubmission;
    await aiApi.start(
      preview.id,
      stableSubmission,
      preview.sessionRevision,
    );
    setPrepared(null);
    submissionId.current = null;
    // A successful native start owns the user message and clears the native draft.
    dirtyRef.current = false;
    dirtyBaseRevision.current = null;
    draftConflict.current = null;
    setDirty(false);
    draftRef.current = "";
    setDraft("");
    messagePageBefore.current = undefined;
    suppressAutoScroll.current = false;
    pendingRestoration.current = null;
    ++messagePageSequence.current;
    await Promise.all([refreshSession(), refreshState(), refreshHistory()]);
  };
  const prepareMessage = (previewOnly = false) =>
    perform(async () => {
      if (!draftRef.current.trim() || !sessionRef.current) return;
      const intent = sessionRef.current;
      const connectionRevision = state?.connections.find(
        (connection) => connection.id === intent.selectedModel?.connectionId,
      )?.revision;
      await flushDraft();
      let current = sessionRef.current;
      if (
        !current ||
        current.id !== intent.id ||
        current.revision !== intent.revision ||
        connectionRevision === undefined
      )
        throw {
          code: "stale_state",
          message: "The conversation changed. Send again after reviewing the selected model.",
        };
      const toMs = Date.now();
      const range =
        fixedTimeRange ??
        (activeScenario === "history"
          ? { fromMs: toMs - historyHours * 3600000, toMs }
          : {});
      if (
        (current.fromMs ?? undefined) !== range.fromMs ||
        (current.toMs ?? undefined) !== range.toMs ||
        current.scenario !== activeScenario ||
        (current.incidentId ?? undefined) !== incidentId
      ) {
        current = await aiApi.setSessionContext(current.id, current.revision, {
          scenario: activeScenario,
          incidentId: incidentId ?? null,
          fromMs: range.fromMs ?? null,
          toMs: range.toMs ?? null,
        });
        adoptSession(current);
      }
      const preview = await aiApi.prepare({
        language: i18n.resolvedLanguage ?? i18n.language,
        sessionId: current.id,
        expectedRevision: current.revision,
        expectedConnectionRevision: connectionRevision,
        text: draftRef.current.trim(),
        scenario: activeScenario,
        includeContext,
        incidentId,
        ...range,
      });
      if (sessionRef.current?.id !== preview.sessionId) return;
      submissionId.current = crypto.randomUUID();
      // Enter/Send is the user's send action for the visible model and selected
      // context. Preparation still freezes the payload and checks native bounds;
      // it is not an extra confirmation step. Review is an explicit alternative.
      if (previewOnly) setPrepared(preview);
      else await startPrepared(preview);
    });
  const activeRun = state?.activeRun;
  const generating = isRunActive(activeRun);
  const thisGenerating = generating && activeRun?.sessionId === session?.id;
  const profile = state?.connections.find(
    (item) => item.id === session?.selectedModel?.connectionId,
  );
  const credentialMissing =
    profile &&
    profile.authKind !== "none" &&
    profile.credentialStatus === "missing";
  const localOnlyBlocked =
    state?.settings.localConnectionsOnly &&
    profile &&
    profile.networkPolicy !== "loopback";
  const setupMessage = !state?.settings.enabled
    ? t("disabled")
    : !session?.selectedModel
      ? t("missingModel")
      : !profile
        ? t("deletedModel")
        : credentialMissing
          ? t("missingCredential")
          : localOnlyBlocked
            ? t("localConnectionsOnly")
            : null;
  const canSend = Boolean(
    state?.settings.enabled &&
      session?.selectedModel &&
      profile &&
      !credentialMissing &&
      !localOnlyBlocked &&
      !generating &&
      !busy &&
      draft.trim(),
  );
  const runError =
    activeRun?.sessionId === session?.id && activeRun?.state === "failed"
      ? activeRun.error
      : null;
  const currentError = error ?? stateError ?? runError;
  const statusText = (status: string) =>
    status === "complete"
      ? t("statusComplete")
      : status === "cancelled"
        ? t("statusCancelled")
        : status === "interrupted"
          ? t("statusInterrupted")
          : status === "failed"
            ? t("statusFailed")
            : t("statusStreaming");
  return (
    <section
      className={`ai-assistant${compact ? " ai-assistant--compact" : ""}`}
      aria-label={t("title")}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          composing.current ||
          event.nativeEvent.isComposing
        )
          return;
        if (confirmation) return;
        if (prepared) {
          event.stopPropagation();
          setPrepared(null);
          return;
        }
        if (modelOpen) {
          event.stopPropagation();
          setModelOpen(false);
          return;
        }
        if (historyOpen && compact) {
          event.stopPropagation();
          setHistoryOpen(false);
          return;
        }
        if (onHide) {
          event.stopPropagation();
          void perform(async () => {
            await flushDraft();
            await onHide();
          });
        }
      }}
    >
      {historyOpen && (
        <aside className="ai-history" aria-label={t("history")}>
          <div className="ai-toolbar">
            <strong>{t("history")}</strong>
            <Button
              className="ai-icon"
              aria-label={t("close")}
              onClick={() => setHistoryOpen(false)}
            >
              <X size={15} />
            </Button>
          </div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void perform(() => newSession())}
          >
            <Plus size={14} />
            {t("newChat")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void perform(() => newSession(true))}
          >
            {t("temporary")}
          </Button>
          <div className="ai-history-list">
            {sessions.map((item) => (
              <div key={item.id}>
                <div
                  className={`ai-history-item${item.id === session?.id ? " is-active" : ""}`}
                >
                  <Button
                    className="ai-history-title"
                    disabled={busy}
                    onClick={() => void perform(() => openSession(item.id))}
                  >
                    <span>{item.title || t("newChat")}</span>
                    <small>
                      {item.temporary
                        ? t("temporary")
                        : new Date(item.updatedAt).toLocaleDateString(
                            i18n.resolvedLanguage,
                          )}
                    </small>
                  </Button>
                  <Button
                    className="ai-icon"
                    aria-label={t("rename")}
                    disabled={busy}
                    onClick={() =>
                      setRenaming({ id: item.id, title: item.title })
                    }
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button
                    className="ai-icon"
                    aria-label={t("deleteChat")}
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({ kind: "session", id: item.id })
                    }
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
                {renaming?.id === item.id && (
                  <form
                    className="ai-model-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(async () => {
                        const next = await aiApi.renameSession(
                          renaming.id,
                          renaming.title.trim(),
                        );
                        adoptSession(next);
                        setRenaming(null);
                        await refreshHistory();
                      });
                    }}
                  >
                    <label className="ai-field">
                      {t("renameName")}
                      <input className="ai-input"
                        value={renaming.title}
                        maxLength={120}
                        autoFocus
                        onChange={(event) =>
                          setRenaming({
                            ...renaming,
                            title: event.target.value,
                          })
                        }
                      />
                    </label>
                    <div className="ai-toolbar">
                      <Button
                        type="submit"
                        disabled={busy || !renaming.title.trim()}
                      >
                        {t("save")}
                      </Button>
                      <Button onClick={() => setRenaming(null)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            ))}
            {hasMore && (
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(() => refreshHistory(sessions.length))
                }
              >
                {t("more")}
              </Button>
            )}
          </div>
          {compact ? (
            <Button
              onClick={() =>
                void perform(async () => {
                  await flushDraft();
                  await onOpenSettings?.();
                })
              }
            >
              {t("storage")}
            </Button>
          ) : (
            <Button
              variant="dangerGhost"
              disabled={busy}
              onClick={() => setConfirmation({ kind: "clear" })}
            >
              {t("clearAll")}
            </Button>
          )}
        </aside>
      )}
      <div className={`ai-chat${prepared ? " ai-chat--preview" : ""}`}>
        <header className="ai-chat-header">
          <div className="ai-chat-heading">
            <h2>{t("title")}</h2>
            <small>
              {session?.temporary
                ? t("temporary")
                : dirty
                  ? t("loading")
                  : session?.storageStatus === "error"
                    ? t("storageError")
                    : t("saved")}
            </small>
          </div>
          <div className="ai-toolbar">
            <Button
              className="ai-icon"
              aria-label={t("history")}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <History size={16} />
            </Button>
            <Button
              className="ai-icon"
              aria-label={t("newChat")}
              disabled={busy}
              onClick={() => void perform(() => newSession())}
            >
              <Plus size={16} />
            </Button>
            {onOpenSettings && (
              <Button
                className="ai-icon"
                aria-label={t("openSettings")}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await flushDraft();
                    await onOpenSettings();
                  })
                }
              >
                <Settings2 size={15} />
              </Button>
            )}
            {onExpand && (
              <Button
                className="ai-icon"
                aria-label={t("expand")}
                disabled={!session || busy}
                onClick={() =>
                  void perform(async () => {
                    const position = captureMessagePosition();
                    await flushDraft();
                    if (sessionRef.current)
                      await onExpand(sessionRef.current.id, position);
                  })
                }
              >
                <Maximize2 size={15} />
              </Button>
            )}
            {onHide && (
              <Button
                className="ai-icon"
                aria-label={t("hide")}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await flushDraft();
                    await onHide();
                  })
                }
              >
                <X size={17} />
              </Button>
            )}
          </div>
        </header>
        <div className="ai-model">
          <Button
            className="ai-model-label"
            aria-label={t("switchModel")}
            onClick={() => {
              setSelection(
                session?.selectedModel ??
                  state?.settings.defaultModel ?? {
                    connectionId: "",
                    modelId: "",
                  },
              );
              setModelOpen(!modelOpen);
            }}
          >
            {profile
              ? `${profile.name} · ${session?.selectedModel?.modelId} · ${endpointLabel(profile.apiBaseUrl)}`
              : t("missingModel")}
            <ChevronDown size={12} />
          </Button>
          {modelOpen && (
            <div className="ai-model-form">
              <label className="ai-field">
                {t("connections")}
                <Select density="compact"
                  value={selection.connectionId}
                  onChange={(event) =>
                    setSelection({
                      ...selection,
                      connectionId: event.target.value,
                    })
                  }
                >
                  <option value="">{t("chooseConnection")}</option>
                  {state?.connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} · {endpointLabel(connection.apiBaseUrl)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="ai-field">
                {t("model")}
                <input className="ai-input"
                  value={selection.modelId}
                  onChange={(event) =>
                    setSelection({ ...selection, modelId: event.target.value })
                  }
                />
              </label>
              <small className="ai-muted">{t("modelChange")}</small>
              <Button
                variant="secondary"
                disabled={
                  busy ||
                  generating ||
                  !session ||
                  !selection.connectionId ||
                  !selection.modelId.trim()
                }
                onClick={() =>
                  void perform(async () => {
                    await flushDraft();
                    const current = sessionRef.current!;
                    const next = await aiApi.selectModel(
                      current.id,
                      current.revision,
                      { ...selection, modelId: selection.modelId.trim() },
                    );
                    adoptSession(next, next.id !== current.id);
                    setPrepared(null);
                    setModelOpen(false);
                    readyCallback.current?.(next.id);
                    await refreshHistory();
                  })
                }
              >
                {t("applyModel")}
              </Button>
            </div>
          )}
        </div>
        {!prepared &&
          session &&
          (session.totalMessages ?? session.messages.length) >
            session.messages.length && (
            <div className="ai-message-pagination">
              <small>
                {t("messagePage", {
                  from: (session.messageOffset ?? 0) + 1,
                  to: (session.messageOffset ?? 0) + session.messages.length,
                  total: session.totalMessages ?? session.messages.length,
                })}
              </small>
              <div className="ai-toolbar">
                {session.hasOlderMessages && (
                  <Button
                    disabled={busy || generating}
                    onClick={() =>
                      void perform(() =>
                        loadMessagePage(session.messageOffset ?? 0),
                      )
                    }
                  >
                    {t("olderMessages")}
                  </Button>
                )}
                {(session.messageOffset ?? 0) + session.messages.length <
                  (session.totalMessages ?? session.messages.length) && (
                  <Button
                    disabled={busy || generating}
                    onClick={() => void perform(() => loadMessagePage())}
                  >
                    {t("latestMessages")}
                  </Button>
                )}
              </div>
            </div>
          )}
        <div
          ref={messagesViewport}
          className="ai-messages"
          aria-label={t("title")}
        >
          {!session?.messages.length && (
            <div className="ai-empty">
              <MessageCircle size={30} />
              <h3>{t("emptyTitle")}</h3>
              {setupMessage && <p>{setupMessage}</p>}
              {setupMessage && onOpenSettings && (
                <Button
                  variant="primary"
                  onClick={() =>
                    void perform(async () => {
                      await flushDraft();
                      await onOpenSettings();
                    })
                  }
                >
                  {t("configure")}
                </Button>
              )}
              <div className="ai-suggestions">
                {(["current_status", "network", "history"] as const).map(
                  (value) => (
                    <Button
                      key={value}
                      variant="secondary"
                      disabled={busy || !session}
                      onClick={() =>
                        void perform(async () => {
                          await changeScenario(value);
                          changeDraft(
                            t(
                              value === "current_status"
                                ? "suggestCurrent"
                                : value === "network"
                                  ? "suggestNetwork"
                                  : "suggestHistory",
                            ),
                          );
                        })
                      }
                    >
                      {t(
                        value === "current_status"
                          ? "scenarioCurrent"
                          : value === "network"
                            ? "scenarioNetwork"
                            : "scenarioHistory",
                      )}
                    </Button>
                  ),
                )}
              </div>
              <Button
                onClick={() => void perform(() => newSession(true))}
                disabled={busy}
              >
                {t("temporary")}
              </Button>
            </div>
          )}
          {session?.messages.map((message) => (
            <article
              key={message.id}
              data-ai-message-id={message.id}
              className={`ai-message ai-message--${message.role}`}
            >
              <div className="ai-message-label">
                <span>{message.role === "user" ? t("you") : "Robin"}</span>
                {message.modelLabel && <span>{message.modelLabel}</span>}
              </div>

              {message.role === "assistant" &&
              message.status === "complete" &&
              message.validatedResult ? (
                <AiResultCard
                  validated={message.validatedResult}
                  busy={busy}
                  onOpenSource={
                    onOpenEvidenceSource
                      ? (target) => {
                          void perform(async () => {
                            await flushDraft();
                            await onOpenEvidenceSource(target);
                          });
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="ai-message-body">
                  {message.role === "assistant" && message.content ? <Suspense fallback={message.content}><AiMarkdown content={message.content} /></Suspense> : message.content || (!message.toolSteps?.length &&
                    (message.status === "pending" ||
                    message.status === "streaming"
                      ? t("waiting")
                      : ""))}
                </div>
              )}
              {Boolean(message.toolSteps?.length) && <AiToolSteps
                steps={message.toolSteps!}
                requestId={message.requestId}
                active={thisGenerating && activeRun?.requestId === message.requestId}
                onResolved={refreshSession}
                onResultReady={revealActiveConfirmation}
                busy={busy || Boolean(activeRun && isRunActive(activeRun))}
                diskRevision={applicationCapabilities?.diskRevision}
                compact={compact}
                onExpand={onExpand ? () => void perform(async () => { await flushDraft(); if (session) await onExpand(session.id, captureMessagePosition()); }) : undefined}
                onAction={(stepId, intent) => void perform(async () => {
                  await flushDraft();
                  const current = sessionRef.current;
                  if (!current || current.id !== session?.id) return;
                  await aiApi.runCapabilityAction({ ...intent, sessionId: current.id, expectedSessionRevision: current.revision, messageId: message.id, stepId, submissionId: crypto.randomUUID() });
                  messagePageBefore.current = undefined;
                  suppressAutoScroll.current = false;
                  pendingRestoration.current = null;
                  ++messagePageSequence.current;
                  await refreshState();
                  await refreshSession();
                })}
              />}
              {message.contextText && (
                <details className="ai-evidence">
                  <summary>{t("evidence")}</summary>
                  <pre>{message.contextText}</pre>
                </details>
              )}
              {message.role === "assistant" && (
                <small className="ai-message-status">
                  {statusText(message.status)}
                  {!message.modelLabel && Boolean(message.toolSteps?.length) && ` · ${i18n.t("capabilities:localAction")}`}
                  {message.usage &&
                    ` · ${t("usage", { input: message.usage.inputTokens ?? t("unknown"), output: message.usage.outputTokens ?? t("unknown") })}`}
                </small>
              )}
              {!message.reusableInContext &&
                (Boolean(message.modelLabel) || !message.toolSteps?.length || message.role === "user") &&
                message.sourceCategories.length > 0 &&
                (message.role === "user" || message.status === "complete") && (
                  <small className="ai-message-status">
                    {t("sourceExpired")}
                  </small>
                )}
            </article>
          ))}
          <div ref={messagesEnd} />
        </div>
        <div className="ai-composer">
          {currentError && (
            <AiErrorNotice error={currentError}>
              {currentError.code.includes("draft") && session && (
                <div className="ai-toolbar">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const latest = await aiApi.getSession(session.id);
                        adoptSession(latest);
                        dirtyBaseRevision.current = latest.draftRevision;
                        draftConflict.current = null;
                        await flushDraft();
                      })
                    }
                  >
                    {t("keepMyDraft")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const latest = await aiApi.getSession(session.id);
                        adoptSession(latest, true);
                      })
                    }
                  >
                    {t("useSavedDraft")}
                  </Button>
                </div>
              )}
            </AiErrorNotice>
          )}
          {session?.storageStatus === "error" && (
            <div className="ai-error" role="alert">
              <p>{t("storageError")}</p>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (savePromise.current) await savePromise.current;
                    const current = sessionRef.current!;
                    if (!dirtyRef.current) {
                      dirtyBaseRevision.current = current.draftRevision;
                      dirtyRef.current = true;
                      setDirty(true);
                    }
                    await flushDraft();
                  })
                }
              >
                {t("save")}
              </Button>
            </div>
          )}
          {state?.storageWarning && (
            <div className="ai-notice">{t("storageWarning")}</div>
          )}
          {generating && !thisGenerating && (
            <div className="ai-notice">{t("busy")}</div>
          )}
          {!!session?.messages.length && setupMessage && (
            <div className="ai-notice">
              <p>{setupMessage}</p>
              {onOpenSettings && (
                <Button
                  onClick={() =>
                    void perform(async () => {
                      await flushDraft();
                      await onOpenSettings();
                    })
                  }
                >
                  {t("configure")}
                </Button>
              )}
            </div>
          )}
          {prepared && (
            <section className="ai-preview" aria-label={t("previewTitle")}>
              <p className="ai-tool-scope">{t("toolPreviewScope")}</p>
              <h3>{t("previewTitle")}</h3>
              <p>
                {prepared.connectionName} · {prepared.selection.modelId}
              </p>
              <p>{t("recipient", { endpoint: prepared.endpoint })}</p>
              <p>
                {t("connectionLocation")}:{" "}
                {t(
                  prepared.connectionLocation === "loopback"
                    ? "loopback"
                    : prepared.connectionLocation === "public"
                      ? "public"
                      : prepared.connectionLocation === "private"
                        ? "private"
                        : "unknown",
                )}
              </p>
              <p>
                {t("processingLocation")}:{" "}
                {t(
                  prepared.processingLocation === "remote"
                    ? "processingRemote"
                    : "processingUnknown",
                )}
              </p>
              {prepared.proxyUrl && (
                <>
                  <p>
                    {t("proxy")}: {prepared.proxyUrl}
                  </p>
                  <p>{t("proxyTargetUnverified")}</p>
                </>
              )}
              <p>{t("sendNotice")}</p>
              <p className="ai-muted">{t("processingNotice")}</p>
              <pre>{prepared.preview}</pre>
              {prepared.history?.length > 0 && (
                <details>
                  <summary>{t("previewHistory")}</summary>
                  <pre>
                    {prepared.history
                      .map((message) => `${message.role}: ${message.content}`)
                      .join("\n\n")}
                  </pre>
                </details>
              )}
              {prepared.coverage?.map((coverage, index) => (
                <p key={index}>{coverage}</p>
              ))}
              {onOpenEvidenceSource && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await flushDraft();
                      await onOpenEvidenceSource(prepared.scenario);
                    })
                  }
                >
                  {t("openEvidenceSource")}
                </Button>
              )}
              <div className="ai-toolbar">
                <Button disabled={busy} onClick={() => setPrepared(null)}>
                  {t("cancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || generating}
                  onClick={() =>
                    void perform(() => startPrepared(prepared))
                  }
                >
                  {t("send")}
                </Button>
              </div>
            </section>
          )}
          {!prepared && (
            <>
              <textarea className="ai-input"
                aria-label={t("input")}
                placeholder={t("placeholder")}
                value={draft}
                disabled={!session || busy}
                onChange={(event) => changeDraft(event.target.value)}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onBlur={() =>
                  void flushDraft().catch((failure) =>
                    setError(aiError(failure)),
                  )
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    !composing.current &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault();
                    if (canSend) void prepareMessage();
                  }
                }}
              />
              <div className="ai-composer-controls">
                <label className="ai-check">
                  <input className="ai-input"
                    type="checkbox"
                    checked={includeContext}
                    disabled={busy || !!prepared}
                    onChange={(event) => {
                      setIncludeContext(event.target.checked);
                      setPrepared(null);
                    }}
                  />
                  <small>{t("includeContext")}</small>
                </label>
                <Button
                  variant="secondary"
                  aria-label={t("preview")}
                  title={t("preview")}
                  disabled={!canSend}
                  onClick={() => void prepareMessage(true)}
                >
                  <Eye size={13} />
                </Button>
                {thisGenerating ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await aiApi.cancel(activeRun!.requestId);
                        await Promise.all([refreshState(), refreshSession()]);
                      })
                    }
                  >
                    <Square size={13} />
                    {t("stop")}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={!canSend || !!prepared}
                    onClick={() => void prepareMessage()}
                  >
                    <Send size={13} />
                    {t("send")}
                  </Button>
                )}
              </div>
              {includeContext && (
                <label className="ai-history-period">
                  {t("contextScope")}
                  <Select density="compact"
                    value={activeScenario}
                    disabled={busy || !!prepared || !session}
                    onChange={(event) => {
                      const value = event.target.value as AiScenario;
                      void perform(() => changeScenario(value));
                    }}
                  >
                    <option value="current_status">
                      {t("scenarioCurrent")}
                    </option>
                    <option value="network">{t("scenarioNetwork")}</option>
                    <option value="history">{t("scenarioHistory")}</option>
                  </Select>
                </label>
              )}
              {activeScenario === "history" && includeContext && (
                <label className="ai-history-period">
                  {t("timeRange")}
                  <Select density="compact"
                    value={fixedTimeRange ? "selected" : historyHours}
                    disabled={busy || !!prepared}
                    onChange={(event) => {
                      const hours = Number(event.target.value);
                      void perform(async () => {
                        await flushDraft();
                        const current = sessionRef.current!;
                        const toMs = Date.now();
                        const next = await aiApi.setSessionContext(
                          current.id,
                          current.revision,
                          {
                            scenario: "history",
                            incidentId: current.incidentId,
                            fromMs: toMs - hours * 3600000,
                            toMs,
                          },
                        );
                        setHistoryHours(hours);
                        adoptSession(next);
                        setPrepared(null);
                      });
                    }}
                  >
                    {fixedTimeRange && (
                      <option value="selected">
                        {new Date(fixedTimeRange.fromMs ?? 0).toLocaleString(
                          i18n.resolvedLanguage,
                        )}{" "}
                        —{" "}
                        {new Date(
                          fixedTimeRange.toMs ?? Date.now(),
                        ).toLocaleString(i18n.resolvedLanguage)}
                      </option>
                    )}
                    <option value={1}>{t("lastHour")}</option>
                    <option value={24}>{t("lastDay")}</option>
                    <option value={168}>{t("lastWeek")}</option>
                  </Select>
                </label>
              )}
              {session?.temporary && <small className="ai-muted">{t("temporaryHint")}</small>}
            </>
          )}
        </div>
      </div>
      {confirmation && (
        <AiConfirm
          title={t(
            confirmation.kind === "clear" ? "clearQuestion" : "deleteQuestion",
          )}
          description={t(
            confirmation.kind === "clear"
              ? "clearDescription"
              : "deleteDescription",
          )}
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={() =>
            void perform(async () => {
              // Stop outstanding draft persistence before deletion. Do not flush or recreate a deleted draft.
              if (savePromise.current)
                await savePromise.current.catch(() => {});
              const deletingCurrent =
                confirmation.kind === "clear" ||
                confirmation.id === sessionRef.current?.id;
              if (confirmation.kind === "clear")
                await aiApi.clearConversations();
              else await aiApi.deleteSession(confirmation.id);
              if (deletingCurrent) {
                ++loadSequence.current;
                sessionRef.current = null;
                setSession(null);
                dirtyRef.current = false;
                dirtyBaseRevision.current = null;
                draftConflict.current = null;
                setDirty(false);
                draftRef.current = "";
                setDraft("");
                setPrepared(null);
                initialization.current = null;
              }
              setConfirmation(null);
              await Promise.all([refreshHistory(), refreshState()]);
            })
          }
        />
      )}
    </section>
  );
}
