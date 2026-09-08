import { normalizeLanguage } from "../language";
import type { TranslationTree } from "./catalogs";

// Auxiliary windows should not carry the main application's full catalog map.
const catalogModules = import.meta.glob("./locales/*/{common,app,wellbeing,splash,tray,companion,ai,capabilities,process,cleanup,network,toolbox,notifications,format}.json", {
  import: "default",
}) as Record<string, () => Promise<TranslationTree>>;
const cache = new Map<string, Promise<TranslationTree>>();

export async function loadSurfaceCatalog(language: string, namespace: string): Promise<TranslationTree> {
  const path = `./locales/${normalizeLanguage(language)}/${namespace}.json`;
  const loader = catalogModules[path];
  if (!loader) throw new Error(`Unsupported surface translation namespace: ${namespace}`);
  let pending = cache.get(path);
  if (!pending) {
    pending = loader();
    cache.set(path, pending);
  }
  return pending;
}
