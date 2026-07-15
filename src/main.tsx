import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import "./App.css";
import App from "./App";
import {
  APP_SETTINGS_STORAGE_KEY,
  applyAppAppearance,
  loadAppSettings,
} from "./settings";

document.documentElement.dataset.surface = "main";
document.body.dataset.surface = "main";
applyAppAppearance(loadAppSettings());
window.addEventListener("storage", ({ key }) => {
  if (key === APP_SETTINGS_STORAGE_KEY) applyAppAppearance(loadAppSettings());
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
