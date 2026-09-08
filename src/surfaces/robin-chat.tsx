import React, { useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import { createInstance } from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { I18nextProvider } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { AiAssistant } from "../components/ai/AiAssistant";
import {
  continueAiInMain,
  hideAiChat,
  AI_CHAT_VISIBILITY_EVENT,
} from "../aiNavigation";
import {
  APP_SETTINGS_STORAGE_KEY,
  applyAppAppearance,
  loadAppAppearance,
} from "../appearance";
import {
  FALLBACK_LANGUAGE,
  initialLanguage,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
} from "../language";
import { loadSurfaceCatalog } from "../i18n/surfaceCatalogs";
import { createAsyncListenerRegistry } from "../asyncListener";
import "../styles/surface-base.css";
import "../styles/robin-chat.css";

const chatI18n = createInstance();
await chatI18n.use(resourcesToBackend(loadSurfaceCatalog)).init({
  lng: initialLanguage(),
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES,
  load: "currentOnly",
  ns: ["ai", "common"],
  defaultNS: "ai",
  interpolation: { escapeValue: false },
});

document.documentElement.dataset.surface = "robin-chat";
document.body.dataset.surface = "robin-chat";
applyAppAppearance(loadAppAppearance());
window.addEventListener("storage", ({ key }) => {
  if (key === APP_SETTINGS_STORAGE_KEY) applyAppAppearance(loadAppAppearance());
  if (key === LANGUAGE_STORAGE_KEY)
    void chatI18n.changeLanguage(initialLanguage());
});

function RobinChatSurface() {
  const session = useRef<string | null>(null);
  const needsFocus = useRef(true);
  const focusInput = async () => {
    if (!needsFocus.current) return;
    const window = getCurrentWindow();
    if (!(await window.isVisible()) || !(await window.isFocused())) return;
    const input = document.querySelector<HTMLTextAreaElement>(
      ".ai-composer textarea:not(:disabled)",
    );
    if (input) {
      input.focus();
      needsFocus.current = false;
    }
  };
  useEffect(() => {
    const listeners = createAsyncListenerRegistry();
    listeners.register(
      listen<boolean>(AI_CHAT_VISIBILITY_EVENT, ({ payload }) => {
        if (listeners.disposed) return;
        needsFocus.current = payload;
        if (payload) requestAnimationFrame(() => void focusInput());
      }),
    );
    return () => listeners.dispose();
  }, []);
  return (
    <I18nextProvider i18n={chatI18n}>
      <AiAssistant
        compact
        onHide={hideAiChat}
        onOpenSettings={async () => {
          await continueAiInMain(session.current, true);
        }}
        onExpand={async (id, position) => {
          await continueAiInMain(id, false, position);
        }}
        onSessionReady={(id) => {
          session.current = id;
          requestAnimationFrame(() => void focusInput());
        }}
      />
    </I18nextProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RobinChatSurface />
  </React.StrictMode>,
);
