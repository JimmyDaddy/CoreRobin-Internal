import { invoke } from "@tauri-apps/api/core";

export interface AiNavigation {
  token: number;
  sessionId: string | null;
  settings: boolean;
  position?: AiMessagePosition | null;
}
export interface AiMessagePosition {
  before: number | null;
  anchorId: string | null;
  anchorOffset: number;
}

export const AI_NAVIGATION_EVENT = "core-robin:ai-navigation";
export const AI_CHAT_VISIBILITY_EVENT = "core-robin:ai-chat-visibility";
export const readAiNavigation = () =>
  invoke<AiNavigation | null>("ai_chat_get_navigation");
export const acknowledgeAiNavigation = (token: number) =>
  invoke<void>("ai_chat_ack_navigation", { token });
export const continueAiInMain = (
  sessionId: string | null,
  settings = false,
  position?: AiMessagePosition,
) =>
  invoke<AiNavigation>("ai_chat_continue_in_main", {
    sessionId,
    settings,
    position,
  });
export const hideAiChat = () => invoke<void>("hide_ai_chat_window");
