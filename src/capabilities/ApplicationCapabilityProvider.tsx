import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BusinessFormId } from "./formCatalog";

interface ApplicationCapabilities {
  render: (id: BusinessFormId, exit: () => void) => ReactNode;
  onOpen?: (id: BusinessFormId) => void;
}
const Context = createContext<ApplicationCapabilities | null>(null);

/** The host owns all controllers. A card cannot create a competing business cache. */
export function ApplicationCapabilityProvider({ value, children }: { value: ApplicationCapabilities; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function BusinessCapabilityOperation({ id, onExit }: { id: BusinessFormId; onExit: () => void }) {
  const host = useContext(Context);
  const { t } = useTranslation("capabilities");
  const current = useRef(host);
  current.current = host;
  const opened = useRef<BusinessFormId | null>(null);
  useEffect(() => {
    if (opened.current === id) return;
    opened.current = id;
    current.current?.onOpen?.(id);
  }, [id]);
  return host?.render(id, onExit) ?? <p role="status">{t("noData")}</p>;
}
