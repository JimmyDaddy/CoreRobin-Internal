import {
ArrowLeft,
CheckCircle2,
ChevronRight,
CircleAlert,
Code2,
FileImage,
FileKey2,
Filter,
Hash,
Heart,
Image as ImageIcon,
Network,
Pipette,
QrCode,
Search,
Sparkles,
Timer,
Wrench,
X
} from "lucide-react";
import type { CSSProperties,ReactNode } from "react";
import { Suspense,useCallback,useEffect,useMemo,useRef,useState } from "react";
import { useTranslation } from "react-i18next";
import { useToolboxCapabilities } from "./useToolboxCapabilities";

import { listen } from "@tauri-apps/api/event";
import { getToolboxStorageSnapshot,isDesktopRuntime,listToolboxHistory,type ToolboxHistoryPage,type ToolboxHistoryRecord } from "../api";
import type { ToolDefinition,ToolId,ToolboxCategory } from "./contracts";
import { getToolDefinition,searchTools,toolboxToolTranslationKey } from "./registry";
import "./toolbox.css";

import { ToolCapabilityNotice,ToolOperation,UnavailableTool,capabilityLabel,capabilityReason,type ToolboxProcessWatchTarget } from "./ToolOperation";
const FAVORITES_KEY = "core-robin.toolbox.favorite-tool-ids.v1";
const HISTORY_PAGE_SIZE = 20;
const CATEGORY_LABEL_KEYS = {
  "system-network": "categories.systemNetwork",
  "text-development": "categories.textDevelopment",
  image: "categories.image",
  "file-patch": "categories.filePatch",
} as const satisfies Record<ToolboxCategory, string>;
const CATEGORY_ICONS: Record<ToolboxCategory, typeof Wrench> = {
  "system-network": Network,
  "text-development": Code2,
  image: ImageIcon,
  "file-patch": FileKey2,
};

export function ToolboxPanel({
  onClose,
  initialProcessWatchTarget,
  onOpenProcessInspector,
}: {
  onClose?: () => void;
  initialProcessWatchTarget?: ToolboxProcessWatchTarget | null;
  onOpenProcessInspector?: () => void;
}) {
  const { t } = useTranslation("toolbox");
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<ToolboxCategory | null>(null);
  const [selected, setSelected] = useState<ToolId | null>(null);
  const returnFocusTarget = useRef<string | null>(null);
  const [favorites, setFavorites] = useState<Set<ToolId>>(() => readFavorites());
  const nativeCapabilities = useToolboxCapabilities();
  const translateTool = useCallback(
    (id: ToolId, field: "title" | "description" | "aliases") =>
      t(toolboxToolTranslationKey(id, field)),
    [t],
  );
  const tools = useMemo(
    () => searchTools(query, nativeCapabilities, translateTool),
    [query, nativeCapabilities, translateTool],
  );
  const visibleTools = useMemo(
    () => activeCategory ? tools.filter((tool) => tool.category === activeCategory) : tools,
    [activeCategory, tools],
  );
  const selectedTool = selected
    ? getToolDefinition(selected, nativeCapabilities, translateTool)
    : null;

  useEffect(() => {
    if (initialProcessWatchTarget?.birthToken) setSelected("process-watch");
  }, [initialProcessWatchTarget]);



  const toggleFavorite = (id: ToolId) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])); } catch { /* private preference is best effort */ }
      return next;
    });
  };

  const openTool = (tool: ToolDefinition, focusTarget: string) => {
    if (tool.capability.state !== "unavailable") {
      returnFocusTarget.current = focusTarget;
      setSelected(tool.id);
    }
  };

  useEffect(() => {
    if (selected !== null || returnFocusTarget.current === null) return;
    const focusTarget = returnFocusTarget.current;
    returnFocusTarget.current = null;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(`[data-toolbox-open="${focusTarget}"]`)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected]);

  return (
    <section className="toolbox-panel" aria-labelledby={selectedTool ? "toolbox-tool-title" : "toolbox-title"}>
      {selectedTool ? (
        <ToolPage tool={selectedTool} onBack={() => setSelected(null)}>
          {selectedTool.capability.state === "unavailable" ? <UnavailableTool tool={selectedTool} /> : <>
            <ToolCapabilityNotice capability={selectedTool.capability} />
            <Suspense fallback={<div className="surface-loading" role="status">{t("loading")}</div>}>
              <ToolOperation
                toolId={selectedTool.id}
                capability={selectedTool.capability}
                processWatchTarget={initialProcessWatchTarget}
                onOpenProcessInspector={onOpenProcessInspector}
              />
            </Suspense>
          </>}
        </ToolPage>
      ) : (
        <>
          <header className="toolbox-panel__header">
            <div className="toolbox-panel__header-main">
              <span className="toolbox-eyebrow"><Sparkles size={14} />CoreRobin</span>
              <h1 id="toolbox-title">{t("title")}</h1>
              <p>{t("description")}</p>
            </div>
            <div className="toolbox-panel__header-side">
              <div className="toolbox-overview-stats" aria-label={t("overview.title")}>
                <span><strong>{tools.length}</strong><small>{t("overview.toolCount", { count: tools.length })}</small></span>
                <span><strong>{tools.filter((tool) => tool.capability.state === "available").length}</strong><small>{t("overview.availableCount", { count: tools.filter((tool) => tool.capability.state === "available").length })}</small></span>
                <span><strong>{favorites.size}</strong><small>{t("overview.favoriteCount", { count: favorites.size })}</small></span>
              </div>
              {onClose ? <button className="icon-button" type="button" aria-label={t("close")} onClick={onClose}><X size={18} /></button> : null}
            </div>
          </header>
          <label className="toolbox-search">
            <Search size={16} />
            <span className="sr-only">{t("search.label")}</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} />
            {query ? <button type="button" aria-label={t("search.clear")} onClick={() => setQuery("")}><X size={14} /></button> : null}
          </label>
          <div className="toolbox-category-tabs" role="group" aria-label={t("categories.label")}>
            <button type="button" className={`toolbox-category-tab${activeCategory === null ? " is-active" : ""}`} aria-pressed={activeCategory === null} onClick={() => setActiveCategory(null)}><Filter size={14} />{t("overview.allCategories")}</button>
            {(Object.keys(CATEGORY_LABEL_KEYS) as ToolboxCategory[]).map((category) => {
              const Icon = CATEGORY_ICONS[category];
              const active = activeCategory === category;
              return <button key={category} type="button" className={`toolbox-category-tab${active ? " is-active" : ""}`} aria-pressed={active} onClick={() => setActiveCategory(active ? null : category)}><Icon size={14} />{t(CATEGORY_LABEL_KEYS[category])}</button>;
            })}
          </div>
          {favorites.size > 0 && !query && activeCategory === null ? <ToolSection sectionId="favorites" title={t("favorites.title")} tools={tools.filter((tool) => favorites.has(tool.id))} favorites={favorites} onOpen={openTool} onFavorite={toggleFavorite} /> : null}
          {(Object.keys(CATEGORY_LABEL_KEYS) as ToolboxCategory[]).filter((category) => activeCategory === null || activeCategory === category).map((category) => (
            <ToolSection key={category} sectionId={category} title={t(CATEGORY_LABEL_KEYS[category])} tools={visibleTools.filter((tool) => tool.category === category)} favorites={favorites} onOpen={openTool} onFavorite={toggleFavorite} />
          ))}
          {visibleTools.length === 0 ? <div className="toolbox-empty"><Wrench size={22} /><strong>{t("empty.title")}</strong><span>{t("empty.description")}</span></div> : null}
          <ToolboxHistoryPanel />
        </>
      )}
    </section>
  );
}

function ToolboxHistoryPanel() {
  const { t } = useTranslation("toolbox");
  const { t: startupT } = useTranslation("startup");
  const latestT = useRef(t);
  const [page, setPage] = useState<ToolboxHistoryPage | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { latestT.current = t; }, [t]);

  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    setLoading(true);
    try {
      const storage = await getToolboxStorageSnapshot();
      setEnabled(storage.policy.toolboxHistoryEnabled);
      setPage(storage.policy.toolboxHistoryEnabled ? await listToolboxHistory({ limit: HISTORY_PAGE_SIZE }) : null);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : latestT.current("history.unavailable"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("system-wake", () => {
      if (!disposed) void refresh();
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const loadMore = async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const nextPage = await listToolboxHistory({ limit: HISTORY_PAGE_SIZE, cursor });
      setPage((current) => {
        if (!current || current.nextCursor !== cursor || current.historyRevision !== nextPage.historyRevision) return current;
        const recordIds = new Set(current.records.map((record) => record.recordId));
        return {
          ...nextPage,
          records: [...current.records, ...nextPage.records.filter((record) => !recordIds.has(record.recordId))],
        };
      });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("history.unavailable"));
    } finally {
      setLoading(false);
    }
  };

  if (!isDesktopRuntime()) return null;

  return <section className="toolbox-section" aria-labelledby="toolbox-history-title">
    <div className="toolbox-section__title"><h2 id="toolbox-history-title">{t("history.title")}</h2><span>{page ? t("history.count", { count: page.records.length }) : enabled === false ? t("history.disabled") : ""}</span></div>
    {enabled === false ? <p className="toolbox-hint">{t("history.disabledDescription")}</p> : null}
    {error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}
    {enabled !== false && page?.records.length ? <div className="toolbox-history-list">{page.records.map((record) => <HistoryRow key={record.recordId} record={record} />)}</div> : null}
    {enabled !== false && page && page.records.length === 0 ? <p className="toolbox-hint">{t("history.empty")}</p> : null}
    <div className="toolbox-inline-actions"><button className="button button--secondary" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? t("history.refreshing") : t("history.refresh")}</button>{page?.nextCursor ? <button className="button button--secondary" type="button" disabled={loading} onClick={() => void loadMore()}>{startupT("showMore", { count: HISTORY_PAGE_SIZE })}</button> : null}{!page || page.records.length <= HISTORY_PAGE_SIZE ? <span className="toolbox-hint">{t("history.privacy")}</span> : null}</div>
  </section>;
}

function HistoryRow({ record }: { record: ToolboxHistoryRecord }) {
  const { t } = useTranslation("toolbox");
  return <div className="toolbox-history-row"><strong>{t(`history.tools.${record.tool}`)}</strong><span>{t(`history.statuses.${record.terminalStatus}`)}</span><small>{new Date(record.completedAtMs).toLocaleString()} · {t("history.notification", { status: t(`history.notifications.${record.notificationStatus}`) })}</small></div>;
}

function ToolSection({ sectionId, title, tools, favorites, onOpen, onFavorite }: { sectionId: string; title: string; tools: ToolDefinition[]; favorites: Set<ToolId>; onOpen: (tool: ToolDefinition, focusTarget: string) => void; onFavorite: (id: ToolId) => void }) {
  const { t } = useTranslation("toolbox");
  if (tools.length === 0) return null;
  const headingId = `toolbox-section-${sectionId}`;
  return (
    <section className="toolbox-section" aria-labelledby={headingId}>
      <div className="toolbox-section__title"><h2 id={headingId}>{title}</h2><span>{tools.length}</span></div>
      <div className="toolbox-grid">
        {tools.map((tool, index) => <article className={`toolbox-card toolbox-card--${tool.capability.state} toolbox-card--${tool.category}`} key={tool.id} style={{ "--toolbox-card-index": index } as CSSProperties}>
          <button className="toolbox-card__open" type="button" data-toolbox-open={`${sectionId}-${tool.id}`} disabled={tool.capability.state === "unavailable"} onClick={() => onOpen(tool, `${sectionId}-${tool.id}`)}>
            <span className="toolbox-card__icon"><ToolIcon id={tool.id} /></span>
            <span className="toolbox-card__content"><span className="toolbox-card__title"><strong>{tool.title}</strong>{tool.capability.state === "available" ? <CheckCircle2 size={14} aria-label={t("overview.availableCount", { count: 1 })} /> : null}</span><small>{tool.description}</small>{tool.capability.state !== "available" ? <small className="toolbox-card__capability"><span>{capabilityLabel(t, tool.capability)}：</span>{capabilityReason(t, tool.capability)}</small> : null}</span>
          </button>
          <span className="toolbox-card__actions">
            <button type="button" className={`toolbox-favorite${favorites.has(tool.id) ? " is-active" : ""}`} aria-label={favorites.has(tool.id) ? t("favorites.remove", { tool: tool.title }) : t("favorites.add", { tool: tool.title })} onClick={() => onFavorite(tool.id)}><Heart size={14} fill={favorites.has(tool.id) ? "currentColor" : "none"} /></button>
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </article>)}
      </div>
    </section>
  );
}

function ToolPage({ tool, onBack, children }: { tool: ToolDefinition; onBack: () => void; children: ReactNode }) {
  const { t } = useTranslation("toolbox");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="toolbox-tool-page"><header className="toolbox-tool-page__header"><button className="button button--secondary" type="button" onClick={onBack}><ArrowLeft size={15} />{t("navigation.back")}</button><div className="toolbox-tool-page__identity"><span className="toolbox-tool-page__icon"><ToolIcon id={tool.id} /></span><div><span className="toolbox-eyebrow">{t(CATEGORY_LABEL_KEYS[tool.category])}</span><h1 id="toolbox-tool-title" ref={heading} tabIndex={-1}>{tool.title}</h1><p>{tool.description}</p></div></div></header>{children}</div>;
}

function ToolIcon({ id }: { id: ToolId }) { if (id === "color-picker") return <Pipette size={18} />; if (id.includes("image") || id.includes("watermark") || id === "c2pa-inspector" || id === "robustness-lab") return <FileImage size={18} />; if (id.includes("patch") || id === "integrity-manifest" || id === "transfer-savings") return <FileKey2 size={18} />; if (id.includes("sha")) return <Hash size={18} />; if (id === "qr-code") return <QrCode size={18} />; if (id.includes("network") || id.includes("occupancy")) return <Network size={18} />; if (id.includes("keep") || id.includes("schedule") || id === "time") return <Timer size={18} />; return <Wrench size={18} />; }

function readFavorites(): Set<ToolId> { try { const parsed: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]"); return new Set(Array.isArray(parsed) ? parsed.filter((value): value is ToolId => typeof value === "string") : []); } catch { return new Set(); } }
