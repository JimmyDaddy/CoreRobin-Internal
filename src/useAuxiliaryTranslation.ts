import { useSyncExternalStore } from "react";

import {
  getAuxiliaryLanguage,
  subscribeAuxiliaryLanguage,
  translateAuxiliary,
  type AuxiliaryTranslate,
} from "./i18nAuxiliary";

export function useAuxiliaryTranslation(): { t: AuxiliaryTranslate } {
  useSyncExternalStore(
    subscribeAuxiliaryLanguage,
    getAuxiliaryLanguage,
    getAuxiliaryLanguage,
  );
  return { t: translateAuxiliary };
}
