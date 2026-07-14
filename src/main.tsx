import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SplashScreen } from "./components/SplashScreen";
import { TrayPanel } from "./components/TrayPanel";
import "./i18n";
import "./App.css";

const surface = new URLSearchParams(window.location.search).get("surface");
document.body.dataset.surface = surface ?? "main";
const Root = surface === "splash"
  ? SplashScreen
  : surface === "tray"
    ? TrayPanel
    : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
