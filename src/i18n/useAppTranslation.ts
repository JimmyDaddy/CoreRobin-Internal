import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { MAIN_NAMESPACES } from "./namespaces";

export type AppTFunction = TFunction<typeof MAIN_NAMESPACES>;

export function useAppTranslation() {
  return useTranslation(MAIN_NAMESPACES);
}
