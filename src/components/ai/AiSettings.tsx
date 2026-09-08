import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Plus, RefreshCw, Settings2 } from "lucide-react";
import { aiApi } from "../../ai/api";
import {
  AI_PRESETS,
  AI_PROTOCOLS,
  apiBaseSuggestion,
  endpointLabel,
  generationEndpointLabel,
} from "../../ai/presets";
import {
  aiError,
  type AiError,
  type ConnectionProfile,
  type ModelInfo,
  type ModelSelection,
  type SaveConnectionInput,
} from "../../ai/types";
import { useAiState } from "../../ai/useAiState";
import { Button } from "../Button";
import { AiConfirm } from "./AiConfirm";
import { AiErrorNotice } from "./AiErrorNotice";
import "../../styles/ai.css";

const emptyConnection = (): SaveConnectionInput => ({
  name: "Ollama",
  protocol: "ollama_native",
  apiBaseUrl: "http://127.0.0.1:11434",
  authKind: "none",
  authHeaderName: null,
  anthropicWorkspaceId: null,
  chatTokenLimitParameter: "auto",
  networkPolicy: "loopback",
  proxyUrl: null,
  proxyNetworkPolicy: null,
  timeoutSeconds: 180,
  maxOutputTokens: 1024,
  stream: true,
});
const connectionFields = [
  "name",
  "protocol",
  "apiBaseUrl",
  "authKind",
  "authHeaderName",
  "anthropicWorkspaceId",
  "chatTokenLimitParameter",
  "networkPolicy",
  "proxyUrl",
  "proxyNetworkPolicy",
  "timeoutSeconds",
  "maxOutputTokens",
  "stream",
] as const;
const capabilityLabels = {
  address: "capabilityAddress",
  discovery: "capabilityDiscovery",
  text: "capabilityText",
} as const;

export function AiSettings({
  onOpenAssistant,
  onReady,
}: {
  onOpenAssistant?: () => void;
  onReady?: () => void;
}) {
  const { t, i18n } = useTranslation("ai");
  const { state, error: stateError, refresh } = useAiState();
  const [editing, setEditing] = useState<SaveConnectionInput | null>(null);
  const [secret, setSecret] = useState("");
  const [temporaryCredential, setTemporaryCredential] = useState(false);
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [selection, setSelection] = useState<ModelSelection>({
    connectionId: "",
    modelId: "",
  });
  const [budget, setBudget] = useState(256);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AiError | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<
    { kind: "clear" } | { kind: "connection"; id: string } | null
  >(null);
  const busyRef = useRef(false);
  const fieldId = useId();
  const lastDefaults = useRef("");
  const readyCalled = useRef(false);
  const previousReadyCallback = useRef(onReady);
  useEffect(() => {
    if (!state) return;
    if (!readyCalled.current || previousReadyCallback.current !== onReady) {
      readyCalled.current = true;
      previousReadyCallback.current = onReady;
      onReady?.();
    }
    const key = JSON.stringify(state.settings);
    if (key !== lastDefaults.current) {
      lastDefaults.current = key;
      setSelection(
        state.settings.defaultModel ?? { connectionId: "", modelId: "" },
      );
      setBudget(Math.round(state.settings.storageBudgetBytes / 1048576));
    }
  }, [state, onReady]);
  const perform = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setError(aiError(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const openEditor = (profile?: ConnectionProfile) => {
    setEditing(
      profile
        ? { ...profile, expectedRevision: profile.revision }
        : emptyConnection(),
    );
    const defaultSelection = state?.settings.defaultModel;
    setSecret("");
    setProxyUsername("");
    setProxyPassword("");
    setTemporaryCredential(false);
    setModel(
      profile &&
        defaultSelection &&
        profile.id === defaultSelection.connectionId
        ? defaultSelection.modelId
        : "",
    );
    setModels(null);
    setError(null);
    setNotice("");
  };
  const refreshEditorRevision = async (connectionId: string) => {
    const latest = await refresh();
    const profile = latest.connections.find((item) => item.id === connectionId);
    if (profile) {
      setEditing((current) =>
        current?.id === connectionId
          ? { ...current, expectedRevision: profile.revision }
          : current,
      );
    }
  };
  const withCredentialRefresh = async (
    connectionId: string,
    operation: () => Promise<void>,
  ) => {
    try {
      await operation();
    } catch (failure) {
      // A failed credential operation may still advance the native profile revision.
      // Retain its original error and the input so session-only storage can be retried.
      await refreshEditorRevision(connectionId).catch(() => {});
      throw failure;
    }
    await refreshEditorRevision(connectionId);
  };
  const saveConnection = () =>
    perform(async () => {
      if (!editing) return;
      const saved = await aiApi.saveConnection(editing);
      setEditing({ ...saved, expectedRevision: saved.revision });
      // Configuration persistence is intentionally separate from credential storage: a failed
      // credential write leaves a repairable connection and never falls back to plaintext.
      await withCredentialRefresh(saved.id, async () => {
        if (secret && editing.authKind !== "none") {
          await aiApi.setCredential(saved.id, secret, temporaryCredential);
          setSecret("");
        }
        if (editing.proxyUrl && (proxyUsername || proxyPassword)) {
          await aiApi.setProxyCredential(
            saved.id,
            proxyUsername,
            proxyPassword,
            temporaryCredential,
          );
          setProxyUsername("");
          setProxyPassword("");
        }
      });
      setNotice(t("savedConnection"));
    });
  const savedProfile = state?.connections.find(
    (item) => item.id === editing?.id,
  );
  const connectionDirty =
    !!editing &&
    (!savedProfile ||
      connectionFields.some((key) => editing[key] !== savedProfile[key]) ||
      !!secret ||
      !!proxyUsername ||
      !!proxyPassword);
  const destinationChanged =
    !!editing &&
    !!savedProfile &&
    (
      [
        "apiBaseUrl",
        "protocol",
        "authKind",
        "authHeaderName",
        "proxyUrl",
      ] as const
    ).some((key) => editing[key] !== savedProfile[key]);
  const currentError = error ?? stateError;
  const suggestedBase = editing
    ? apiBaseSuggestion(editing.apiBaseUrl, editing.protocol)
    : null;
  const generationEndpoint = editing
    ? generationEndpointLabel(
        suggestedBase ?? editing.apiBaseUrl,
        editing.protocol,
      )
    : "";
  const discoveredModel = models?.find((item) => item.id === model.trim());
  const capabilityRecords = (state?.capabilities ?? []).filter(
    (record) =>
      savedProfile &&
      record.connectionId === savedProfile.id &&
      record.profileRevision === savedProfile.revision &&
      record.modelId ===
        (record.kind === "address" || record.kind === "discovery"
          ? ""
          : model.trim()),
  );
  const withCapabilityRefresh = async <T,>(operation: () => Promise<T>) => {
    let result: T;
    try {
      result = await operation();
    } catch (failure) {
      // Failed checks are useful records too. Keep the original failure if refresh fails.
      await refresh().catch(() => {});
      throw failure;
    }
    await refresh();
    return result;
  };
  const testModel = () =>
    perform(async () => {
      if (!editing?.id || !model.trim() || connectionDirty) return;
      const selected = { connectionId: editing.id, modelId: model.trim() };
      const result = await withCapabilityRefresh(() =>
        aiApi.testModel(selected),
      );
      setNotice(t("testSuccess", { text: result.text }));
    });
  return (
    <section className="ai-settings" aria-label={t("settingsTitle")}>
      <div className="ai-card">
        <header>
          <div>
            <h2>{t("settingsTitle")}</h2>
            <p>{t("intro")}</p>
          </div>
          <Settings2 size={22} />
        </header>
        <label className="ai-check">
          <input
            type="checkbox"
            role="switch"
            checked={state?.settings.enabled ?? false}
            disabled={!state || busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void perform(async () => {
                if (state) {
                  await aiApi.updateSettings({ ...state.settings, enabled });
                  await refresh();
                }
              });
            }}
          />
          {t("enable")}
        </label>
        <p className="ai-muted">{t("noAutoSwitch")}</p>
        <label className="ai-check">
          <input
            type="checkbox"
            checked={state?.settings.localConnectionsOnly ?? false}
            disabled={!state || busy}
            onChange={(event) => {
              const localConnectionsOnly = event.target.checked;
              void perform(async () => {
                await aiApi.updateSettings({
                  ...state!.settings,
                  localConnectionsOnly,
                });
                await refresh();
              });
            }}
          />
          {t("localConnectionsOnly")}
        </label>
        <p className="ai-muted">{t("localConnectionsHint")}</p>
      </div>
      {currentError && (
        <AiErrorNotice error={currentError}>
          <Button onClick={() => void refresh().catch(() => {})}>
            {t("retry")}
          </Button>
        </AiErrorNotice>
      )}
      {notice && (
        <div className="ai-notice" role="status">
          {notice}
        </div>
      )}
      <div className="ai-card">
        <header>
          <h3>{t("connections")}</h3>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => openEditor()}
          >
            <Plus size={14} />
            {t("addConnection")}
          </Button>
        </header>
        <ul className="ai-connections">
          {state?.connections.map((connection) => (
            <li key={connection.id} className="ai-connection">
              <div>
                <strong>{connection.name}</strong>
                <small>
                  {endpointLabel(connection.apiBaseUrl)} · {connection.protocol}
                </small>
              </div>
              <div className="ai-toolbar">
                <Button
                  aria-label={t("copyConnection")}
                  disabled={busy}
                  onClick={() => {
                    openEditor();
                    setEditing({
                      ...connection,
                      id: undefined,
                      expectedRevision: undefined,
                      name: `${connection.name} · ${t("copyConnection")}`,
                    });
                    setNotice(t("copyConnectionHint"));
                  }}
                >
                  <Copy size={14} />
                </Button>
                <Button disabled={busy} onClick={() => openEditor(connection)}>
                  {t("edit")}
                </Button>
                <Button
                  variant="dangerGhost"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({ kind: "connection", id: connection.id })
                  }
                >
                  {t("remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveConnection();
            }}
          >
            <fieldset
              disabled={busy}
              style={{ border: 0, padding: 0, margin: 0 }}
            >
              <div className="ai-fields">
                {!editing.id && (
                  <label className="ai-field ai-field--wide">
                    {t("connections")}
                    <select
                      defaultValue="ollama"
                      onChange={(event) => {
                        const preset = AI_PRESETS.find(
                          (item) => item.id === event.target.value,
                        )!;
                        setEditing({
                          ...emptyConnection(),
                          name: preset.name || t("custom"),
                          protocol: preset.protocol,
                          apiBaseUrl: preset.baseUrl,
                          authKind: preset.authMode,
                          networkPolicy:
                            preset.id === "ollama" ? "loopback" : "public",
                        });
                        setSecret("");
                        setModels(null);
                      }}
                    >
                      {AI_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name || t("custom")}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="ai-field">
                  {t("name")}
                  <input
                    required
                    maxLength={120}
                    value={editing.name}
                    onChange={(event) =>
                      setEditing({ ...editing, name: event.target.value })
                    }
                  />
                </label>
                <label className="ai-field">
                  {t("protocol")}
                  <select
                    value={editing.protocol}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        protocol: event.target
                          .value as ConnectionProfile["protocol"],
                        anthropicWorkspaceId:
                          event.target.value === "anthropic_messages"
                            ? editing.anthropicWorkspaceId
                            : null,
                        chatTokenLimitParameter:
                          event.target.value === "openai_chat"
                            ? editing.chatTokenLimitParameter
                            : "auto",
                        authHeaderName:
                          editing.authKind === "custom_header"
                            ? editing.authHeaderName
                            : null,
                      })
                    }
                  >
                    {AI_PROTOCOLS.map((protocol) => (
                      <option key={protocol.value} value={protocol.value}>
                        {protocol.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ai-field ai-field--wide">
                  {t("baseUrl")}
                  <input
                    aria-label={t("baseUrl")}
                    required
                    type="url"
                    spellCheck={false}
                    autoCapitalize="none"
                    value={editing.apiBaseUrl}
                    placeholder="https://…"
                    onChange={(event) =>
                      setEditing({ ...editing, apiBaseUrl: event.target.value })
                    }
                  />
                  <small>{t("networkHint")}</small>
                </label>
                <label className="ai-field">
                  {t("network")}
                  <select
                    value={editing.networkPolicy}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        networkPolicy: event.target
                          .value as ConnectionProfile["networkPolicy"],
                      })
                    }
                  >
                    <option value="loopback">{t("loopback")}</option>
                    <option value="public">{t("public")}</option>
                    <option value="private">{t("private")}</option>
                  </select>
                </label>
                {suggestedBase ? (
                  <div className="ai-field ai-field--wide ai-notice">
                    <p>{t("baseSuggestion")}</p>
                    <p>
                      {t("generationEndpoint", {
                        endpoint: editing.apiBaseUrl,
                      })}
                    </p>
                    <p>{t("suggestedBase", { base: suggestedBase })}</p>
                    <Button
                      onClick={() =>
                        setEditing({ ...editing, apiBaseUrl: suggestedBase })
                      }
                    >
                      {t("useSuggestedBase")}
                    </Button>
                  </div>
                ) : (
                  generationEndpoint && (
                    <p className="ai-field--wide ai-muted">
                      {t("generationEndpoint", {
                        endpoint: generationEndpoint,
                      })}
                    </p>
                  )
                )}
                <label className="ai-field">
                  {t("auth")}
                  <select
                    value={editing.authKind}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        authKind: event.target
                          .value as ConnectionProfile["authKind"],
                        authHeaderName:
                          event.target.value === "custom_header"
                            ? editing.authHeaderName
                            : null,
                      })
                    }
                  >
                    <option value="none">{t("none")}</option>
                    <option value="bearer">{t("bearer")}</option>
                    <option value="api_key">{t("apiKey")}</option>
                    <option value="custom_header">{t("customHeader")}</option>
                  </select>
                </label>
                {editing.authKind === "custom_header" && (
                  <label className="ai-field ai-field--wide">
                    {t("headerName")}
                    <input
                      required
                      value={editing.authHeaderName ?? ""}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          authHeaderName: event.target.value,
                        })
                      }
                      spellCheck={false}
                    />
                  </label>
                )}
                {editing.authKind !== "none" && (
                  <>
                    <label className="ai-field ai-field--wide">
                      {t("secret")}
                      <input
                        aria-label={t("secret")}
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                      />
                      <small>{t("secretHint")}</small>
                    </label>
                    <label className="ai-check ai-field--wide">
                      <input
                        type="checkbox"
                        checked={temporaryCredential}
                        onChange={(event) =>
                          setTemporaryCredential(event.target.checked)
                        }
                      />
                      {t("temporaryCredential")}
                    </label>
                  </>
                )}
              </div>
              {destinationChanged && (
                <p className="ai-notice">{t("credentialChanged")}</p>
              )}
              <details style={{ margin: "14px 0" }}>
                <summary>{t("advanced")}</summary>
                <div className="ai-fields" style={{ marginTop: 12 }}>
                  <label className="ai-field">
                    {t("timeout")}
                    <input
                      type="number"
                      min={10}
                      max={300}
                      value={editing.timeoutSeconds}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          timeoutSeconds: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="ai-field">
                    {t("outputLimit")}
                    <input
                      type="number"
                      min={32}
                      max={8192}
                      value={editing.maxOutputTokens}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          maxOutputTokens: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="ai-field ai-field--wide">
                    {t("proxy")}
                    <input
                      type="url"
                      value={editing.proxyUrl ?? ""}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          proxyUrl: event.target.value || null,
                          proxyNetworkPolicy: event.target.value
                            ? editing.proxyNetworkPolicy
                            : null,
                        })
                      }
                    />
                    <small>{t("proxyHint")}</small>
                  </label>
                  {editing.proxyUrl && (
                    <>
                      <label className="ai-field ai-field--wide">
                        {t("proxyNetwork")}
                        <select
                          value={editing.proxyNetworkPolicy ?? "auto"}
                          onChange={(event) =>
                            setEditing({
                              ...editing,
                              proxyNetworkPolicy:
                                event.target.value === "auto"
                                  ? null
                                  : (event.target
                                      .value as ConnectionProfile["networkPolicy"]),
                            })
                          }
                        >
                          <option value="auto">{t("automatic")}</option>
                          <option value="loopback">{t("loopback")}</option>
                          <option value="public">{t("public")}</option>
                          <option value="private">{t("private")}</option>
                        </select>
                        <small>{t("proxyTargetUnverified")}</small>
                      </label>
                      <label className="ai-field">
                        {t("proxyUsername")}
                        <input
                          autoComplete="off"
                          value={proxyUsername}
                          onChange={(event) =>
                            setProxyUsername(event.target.value)
                          }
                        />
                      </label>
                      <label className="ai-field">
                        {t("proxyPassword")}
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={proxyPassword}
                          onChange={(event) =>
                            setProxyPassword(event.target.value)
                          }
                        />
                      </label>
                      {editing.id && (
                        <Button
                          variant="dangerGhost"
                          onClick={() =>
                            void perform(async () => {
                              await withCredentialRefresh(editing.id!, () =>
                                aiApi.deleteProxyCredential(editing.id!),
                              );
                            })
                          }
                        >
                          {t("proxyCredentialRemove")}
                        </Button>
                      )}
                    </>
                  )}
                  {editing.protocol === "anthropic_messages" && (
                    <label className="ai-field ai-field--wide">
                      {t("workspaceId")}
                      <input
                        value={editing.anthropicWorkspaceId ?? ""}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            anthropicWorkspaceId: event.target.value || null,
                          })
                        }
                      />
                    </label>
                  )}
                  {editing.protocol === "openai_chat" && (
                    <label className="ai-field ai-field--wide">
                      {t("tokenParameter")}
                      <select
                        value={editing.chatTokenLimitParameter}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            chatTokenLimitParameter: event.target
                              .value as ConnectionProfile["chatTokenLimitParameter"],
                          })
                        }
                      >
                        <option value="auto">{t("automatic")}</option>
                        <option value="max_tokens">max_tokens</option>
                        <option value="max_completion_tokens">
                          max_completion_tokens
                        </option>
                      </select>
                    </label>
                  )}
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={editing.stream}
                      onChange={(event) =>
                        setEditing({ ...editing, stream: event.target.checked })
                      }
                    />
                    {t("stream")}
                  </label>
                </div>
              </details>
              <div className="ai-toolbar">
                <Button variant="primary" type="submit">
                  {t("save")}
                </Button>
                <Button
                  onClick={() => {
                    setEditing(null);
                    setSecret("");
                    setProxyUsername("");
                    setProxyPassword("");
                  }}
                >
                  {t("close")}
                </Button>
                {editing.id && (
                  <Button
                    variant="dangerGhost"
                    onClick={() =>
                      void perform(async () => {
                        await withCredentialRefresh(editing.id!, () =>
                          aiApi.deleteCredential(editing.id!),
                        );
                      })
                    }
                  >
                    {t("credentialRemove")}
                  </Button>
                )}
              </div>
            </fieldset>
            {editing.id ? (
              <div className="ai-notice">
                <div className="ai-field">
                  <label htmlFor={`${fieldId}-model`}>{t("model")}</label>
                  <input
                    id={`${fieldId}-model`}
                    list={`${fieldId}-models`}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    spellCheck={false}
                  />
                  <datalist id={`${fieldId}-models`}>
                    {models?.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.processingLocation === "remote"
                          ? ` · ${t("processingRemote")}`
                          : ""}
                      </option>
                    ))}
                  </datalist>
                  {discoveredModel && (
                    <small>
                      {t("processingLocation")}:{" "}
                      {t(
                        discoveredModel.processingLocation === "remote"
                          ? "processingRemote"
                          : "processingUnknown",
                      )}
                    </small>
                  )}
                </div>
                <p>{connectionDirty ? t("saveChangesFirst") : t("testHint")}</p>
                <div className="ai-toolbar">
                  <Button
                    disabled={busy || connectionDirty}
                    onClick={() =>
                      void perform(async () => {
                        const result = await withCapabilityRefresh(() =>
                          aiApi.listModels(editing.id!),
                        );
                        setModels(result);
                        if (!result.length) setNotice(t("modelsEmpty"));
                      })
                    }
                  >
                    <RefreshCw size={13} />
                    {t("refreshModels")}
                  </Button>
                  <Button
                    disabled={busy || connectionDirty || !model.trim()}
                    onClick={() => void testModel()}
                  >
                    {t("testModel")}
                  </Button>
                  <Button
                    disabled={
                      busy || connectionDirty || !model.trim() || !state
                    }
                    onClick={() =>
                      void perform(async () => {
                        await aiApi.updateSettings({
                          ...state!.settings,
                          defaultModel: {
                            connectionId: editing.id!,
                            modelId: model.trim(),
                          },
                        });
                        await refresh();
                        setNotice(t("defaultSaved"));
                      })
                    }
                  >
                    {t("setDefault")}
                  </Button>
                </div>
                <section
                  className="ai-capabilities"
                  aria-label={t("capabilitiesTitle")}
                >
                  <h4>{t("capabilitiesTitle")}</h4>
                  <p className="ai-muted">{t("capabilityScopeHint")}</p>
                  <p className="ai-muted">{t("capabilityAddressHint")}</p>
                  {savedProfile && (
                    <p className="ai-muted">
                      {t("capabilityParameters", {
                        stream: t(
                          savedProfile.stream
                            ? "capabilityStreamOn"
                            : "capabilityStreamOff",
                        ),
                        tokens: savedProfile.maxOutputTokens,
                      })}
                    </p>
                  )}
                  <ul>
                    {(
                      Object.keys(
                        capabilityLabels,
                      ) as (keyof typeof capabilityLabels)[]
                    ).map((kind) => {
                      const record = capabilityRecords
                        .filter((item) => item.kind === kind)
                        .sort((a, b) => b.checkedAt - a.checkedAt)[0];
                      return (
                        <li key={kind}>
                          <strong>{t(capabilityLabels[kind])}</strong>
                          <span>
                            {t(
                              record?.status === "verified"
                                ? "capabilityVerified"
                                : record?.status === "failed"
                                  ? "capabilityFailed"
                                  : record?.status === "expired"
                                    ? "capabilityExpired"
                                    : "capabilityUntested",
                            )}
                          </span>
                          {record && (
                            <time
                              dateTime={new Date(
                                record.checkedAt,
                              ).toISOString()}
                            >
                              {t("capabilityCheckedAt", {
                                time: new Date(record.checkedAt).toLocaleString(
                                  i18n.resolvedLanguage ?? i18n.language,
                                ),
                              })}
                            </time>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>
            ) : (
              <p className="ai-muted">{t("saveFirst")}</p>
            )}
          </form>
        )}
      </div>
      <div className="ai-card">
        <header>
          <h3>{t("defaultModel")}</h3>
        </header>
        <div className="ai-fields">
          <label className="ai-field">
            {t("connections")}
            <select
              value={selection.connectionId}
              onChange={(event) =>
                setSelection({ ...selection, connectionId: event.target.value })
              }
            >
              <option value="">{t("chooseConnection")}</option>
              {state?.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ai-field">
            {t("model")}
            <input
              value={selection.modelId}
              onChange={(event) =>
                setSelection({ ...selection, modelId: event.target.value })
              }
            />
          </label>
        </div>
        <div className="ai-toolbar" style={{ marginTop: 12 }}>
          <Button
            disabled={
              !state ||
              busy ||
              !selection.connectionId ||
              !selection.modelId.trim()
            }
            variant="primary"
            onClick={() =>
              void perform(async () => {
                await aiApi.updateSettings({
                  ...state!.settings,
                  defaultModel: {
                    ...selection,
                    modelId: selection.modelId.trim(),
                  },
                });
                await refresh();
                setNotice(t("defaultSaved"));
              })
            }
          >
            {t("save")}
          </Button>
          {onOpenAssistant && (
            <Button onClick={onOpenAssistant}>{t("title")}</Button>
          )}
        </div>
      </div>
      <div className="ai-card">
        <header>
          <h3>{t("storage")}</h3>
        </header>
        <p>
          {t("storageUsage", {
            used: ((state?.storageBytes ?? 0) / 1048576).toFixed(1),
            budget: Math.round(
              (state?.settings.storageBudgetBytes ?? 268435456) / 1048576,
            ),
          })}
        </p>
        {state?.storageWarning && <p role="status">{t("storageWarning")}</p>}
        <div className="ai-fields">
          <label className="ai-field">
            {t("storageBudget")}
            <input
              type="number"
              min={8}
              max={2048}
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="ai-toolbar" style={{ marginTop: 12 }}>
          <Button
            disabled={!state || busy}
            onClick={() =>
              void perform(async () => {
                await aiApi.updateSettings({
                  ...state!.settings,
                  storageBudgetBytes: budget * 1048576,
                });
                await refresh();
              })
            }
          >
            {t("save")}
          </Button>
          <Button
            variant="dangerGhost"
            disabled={busy}
            onClick={() => setConfirmation({ kind: "clear" })}
          >
            {t("clearAll")}
          </Button>
        </div>
      </div>
      <section className="ai-card" aria-label={t("helpTitle")}>
        <h3>{t("helpTitle")}</h3>
        <p>{t("ollamaHelpHint")}</p>
        <div className="ai-toolbar">
          {AI_PRESETS.filter((preset) => preset.id !== "custom").map(
            (preset) => (
              <Button
                key={preset.id}
                disabled={busy}
                onClick={() => void perform(() => aiApi.openHelp(preset.id))}
              >
                {t("helpProvider", { provider: preset.name })}
              </Button>
            ),
          )}
        </div>
        <p>{t("providerPoliciesHint")}</p>
        <Button
          disabled={busy}
          onClick={() => void perform(() => aiApi.openHelp("openai-data"))}
        >
          {t("dataPrivacyHelp")}
        </Button>
      </section>
      {confirmation && (
        <AiConfirm
          title={t(
            confirmation.kind === "clear"
              ? "clearQuestion"
              : "deleteConnectionQuestion",
          )}
          description={t(
            confirmation.kind === "clear"
              ? "clearDescription"
              : "deleteConnectionDescription",
          )}
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={() =>
            void perform(async () => {
              if (confirmation.kind === "clear")
                await aiApi.clearConversations();
              else {
                await aiApi.deleteConnection(confirmation.id);
                if (editing?.id === confirmation.id) {
                  setEditing(null);
                  setSecret("");
                  setProxyUsername("");
                  setProxyPassword("");
                }
              }
              setConfirmation(null);
              await refresh();
            })
          }
        />
      )}
    </section>
  );
}
