import React, { type ComponentType } from "react";
import ReactDOM from "react-dom/client";

import {
  APP_SETTINGS_STORAGE_KEY,
  applyAppAppearance,
  loadAppAppearance,
} from "../appearance";
import { changeAuxiliaryLanguage } from "../i18nAuxiliary";
import { initialLanguage, LANGUAGE_STORAGE_KEY } from "../language";

export function bootstrapAuxiliarySurface(
  surface: "splash" | "tray" | "companion",
  Root: ComponentType,
): void {
  document.documentElement.dataset.surface = surface;
  document.body.dataset.surface = surface;
  applyAppAppearance(loadAppAppearance());

  window.addEventListener("storage", ({ key }) => {
    if (key === APP_SETTINGS_STORAGE_KEY) {
      applyAppAppearance(loadAppAppearance());
    }
    if (key === LANGUAGE_STORAGE_KEY) {
      void changeAuxiliaryLanguage(initialLanguage());
    }
  });

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}
