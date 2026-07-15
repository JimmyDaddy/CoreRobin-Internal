import React, { type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import "./App.css";
import {
  APP_SETTINGS_STORAGE_KEY,
  applyAppAppearance,
  loadAppSettings,
} from "./settings";

const surface = new URLSearchParams(window.location.search).get("surface");
const activeSurface = surface ?? "main";
document.documentElement.dataset.surface = activeSurface;
document.body.dataset.surface = activeSurface;
applyAppAppearance(loadAppSettings());
window.addEventListener("storage", ({ key }) => {
  if (key === APP_SETTINGS_STORAGE_KEY) applyAppAppearance(loadAppSettings());
});

async function loadSurface(): Promise<ComponentType> {
  if (surface === "splash") {
    return (await import("./components/SplashScreen")).SplashScreen;
  }
  if (surface === "tray") {
    return (await import("./components/TrayPanel")).TrayPanel;
  }
  if (surface === "companion") {
    return (await import("./components/OrbitCompanionWindow")).OrbitCompanionWindow;
  }
  return (await import("./App")).default;
}

void loadSurface().then((Root) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
