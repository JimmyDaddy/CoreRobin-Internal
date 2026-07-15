import brandMark from "../../src-tauri/icons/128x128@2x.png";
import {
  APP_SETTINGS_STORAGE_KEY,
  applyAppAppearance,
  loadAppAppearance,
} from "../appearance";
import {
  changeAuxiliaryLanguage,
  translateAuxiliary,
} from "../i18nAuxiliary";
import { initialLanguage, LANGUAGE_STORAGE_KEY } from "../language";
import "../styles/splash.css";

document.documentElement.dataset.surface = "splash";
document.body.dataset.surface = "splash";
applyAppAppearance(loadAppAppearance());

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing splash root element");
const root = rootElement;

root.innerHTML = `
  <main class="splash-surface">
    <div class="splash-card">
      <div class="splash-aurora splash-aurora--one"></div>
      <div class="splash-aurora splash-aurora--two"></div>
      <div class="splash-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="splash-logo" aria-hidden="true"><img alt="" /></div>
      <div class="splash-copy">
        <span class="splash-eyebrow">LOCAL · PRIVATE · LIVE</span>
        <h1>StatusOrbit</h1>
        <p data-i18n="description"></p>
      </div>
      <div class="splash-progress" aria-hidden="true"><span></span></div>
      <div class="splash-stage"><i></i><span data-i18n="connecting"></span></div>
    </div>
  </main>`;

const image = root.querySelector<HTMLImageElement>(".splash-logo img");
if (image) image.src = brandMark;

function renderLanguage(): void {
  const surface = root.querySelector<HTMLElement>(".splash-surface");
  if (surface) surface.setAttribute("aria-label", translateAuxiliary("splash.title"));
  const description = root.querySelector<HTMLElement>("[data-i18n='description']");
  if (description) description.textContent = translateAuxiliary("splash.description");
  const connecting = root.querySelector<HTMLElement>("[data-i18n='connecting']");
  if (connecting) connecting.textContent = translateAuxiliary("splash.connecting");
}

renderLanguage();
window.addEventListener("storage", ({ key }) => {
  if (key === APP_SETTINGS_STORAGE_KEY) {
    applyAppAppearance(loadAppAppearance());
  }
  if (key === LANGUAGE_STORAGE_KEY) {
    changeAuxiliaryLanguage(initialLanguage());
    renderLanguage();
  }
});
