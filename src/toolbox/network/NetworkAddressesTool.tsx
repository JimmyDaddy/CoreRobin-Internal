import { CircleAlert, Copy, Network, RefreshCw } from "lucide-react";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { userFacingError, ToolboxInputError } from "../local/toolboxErrors";
import {
  parseIfconfig,
  parseNetworkInterfaceSnapshot,
  type AddressClassification,
  type NetworkAddressesSnapshot,
  type ParsedAddress,
  type ParsedInterface,
} from "./networkTools";
import "./network.css";

export interface NetworkAddressesToolProps {
  /** The coordinator supplies the native, on-demand snapshot bridge. */
  loadSnapshot: () => Promise<NetworkAddressesSnapshot>;
  initialView?: "live" | "ifconfig";
}

type ToolboxTFunction = TFunction<"toolbox">;

const CLASSIFICATION_KEYS = {
  unspecified: "networkAddresses.classifications.unspecified",
  loopback: "networkAddresses.classifications.loopback",
  private: "networkAddresses.classifications.private",
  "unique-local": "networkAddresses.classifications.uniqueLocal",
  "link-local": "networkAddresses.classifications.linkLocal",
  multicast: "networkAddresses.classifications.multicast",
  shared: "networkAddresses.classifications.shared",
  documentation: "networkAddresses.classifications.documentation",
  "ipv4-mapped": "networkAddresses.classifications.ipv4Mapped",
  "global-unicast": "networkAddresses.classifications.globalUnicast",
  reserved: "networkAddresses.classifications.reserved",
} as const satisfies Record<AddressClassification, string>;

const FAMILY_KEYS = {
  ipv4: "networkAddresses.family.ipv4",
  ipv6: "networkAddresses.family.ipv6",
} as const satisfies Record<ParsedAddress["family"], string>;

const EXPLANATION_KEYS = {
  ipv4: {
    unspecified: "networkAddresses.explanations.ipv4.unspecified",
    loopback: "networkAddresses.explanations.ipv4.loopback",
    private: "networkAddresses.explanations.ipv4.private",
    "unique-local": "networkAddresses.explanations.ipv4.uniqueLocal",
    "link-local": "networkAddresses.explanations.ipv4.linkLocal",
    multicast: "networkAddresses.explanations.ipv4.multicast",
    shared: "networkAddresses.explanations.ipv4.shared",
    documentation: "networkAddresses.explanations.ipv4.documentation",
    "ipv4-mapped": "networkAddresses.explanations.ipv4.ipv4Mapped",
    "global-unicast": "networkAddresses.explanations.ipv4.globalUnicast",
    reserved: "networkAddresses.explanations.ipv4.reserved",
  },
  ipv6: {
    unspecified: "networkAddresses.explanations.ipv6.unspecified",
    loopback: "networkAddresses.explanations.ipv6.loopback",
    private: "networkAddresses.explanations.ipv6.private",
    "unique-local": "networkAddresses.explanations.ipv6.uniqueLocal",
    "link-local": "networkAddresses.explanations.ipv6.linkLocal",
    multicast: "networkAddresses.explanations.ipv6.multicast",
    shared: "networkAddresses.explanations.ipv6.shared",
    documentation: "networkAddresses.explanations.ipv6.documentation",
    "ipv4-mapped": "networkAddresses.explanations.ipv6.ipv4Mapped",
    "global-unicast": "networkAddresses.explanations.ipv6.globalUnicast",
    reserved: "networkAddresses.explanations.ipv6.reserved",
  },
} as const satisfies Record<ParsedAddress["family"], Record<AddressClassification, string>>;

export function NetworkAddressesTool({ loadSnapshot, initialView = "live" }: NetworkAddressesToolProps) {
  const { t } = useTranslation("toolbox");
  const [view, setView] = useState<"live" | "ifconfig">(initialView);
  const requestGeneration = useRef(0);
  const [snapshot, setSnapshot] = useState<NetworkAddressesSnapshot | null>(null);
  const [interfaces, setInterfaces] = useState<ParsedInterface[]>([]);
  const [ifconfigInput, setIfconfigInput] = useState("");
  const [ifconfigInterfaces, setIfconfigInterfaces] = useState<ParsedInterface[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    setCopyStatus("");
    try {
      const next = await loadSnapshot();
      if (generation !== requestGeneration.current) return;
      if (!Number.isSafeInteger(next.sampledAtMs) || next.sampledAtMs <= 0) {
        throw new ToolboxInputError("invalid_sampled_time", "本机地址快照的采样时间无效。 ");
      }
      if (next.interfaces.length > 128) {
        throw new ToolboxInputError("too_many_interfaces", "本机网卡数量超过 128 个上限。 ");
      }
      setSnapshot(next);
      setInterfaces(next.interfaces.map(parseNetworkInterfaceSnapshot));
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setSnapshot(null);
      setInterfaces([]);
      setError(userFacingError(reason));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [loadSnapshot]);

  useEffect(() => {
    if (view === "live") void refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh, view]);

  const copyText = useCallback(async (text: string, label: string) => {
    setCopyStatus("");
    if (!navigator.clipboard?.writeText) {
      setError(t("networkAddresses.copy.unsupported"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(t("networkAddresses.copy.success", { label }));
    } catch {
      setError(t("networkAddresses.copy.failure"));
    }
  }, [t]);

  const parsePastedIfconfig = () => {
    setError("");
    setCopyStatus("");
    try {
      setIfconfigInterfaces(parseIfconfig(ifconfigInput));
    } catch (reason) {
      setIfconfigInterfaces(null);
      setError(userFacingError(reason));
    }
  };

  const liveSummary = useMemo(() => interfaces.map((item) => interfaceSummary(item, t)).join("\n\n"), [interfaces, t]);

  return (
    <section className="network-addresses-tool" aria-labelledby="network-addresses-title">
      <header className="network-addresses-tool__intro">
        <div>
          <span className="toolbox-eyebrow"><Network size={14} />{t("networkAddresses.eyebrow")}</span>
          <h2 id="network-addresses-title">{t("networkAddresses.title")}</h2>
          <p>{t("networkAddresses.description")}</p>
        </div>
        {view === "live" ? <button className="button button--secondary" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} />{loading ? t("networkAddresses.refreshing") : t("networkAddresses.refresh")}</button> : null}
      </header>

      <p className="network-addresses-tool__privacy"><CircleAlert size={15} />{t("networkAddresses.privacy")}</p>
      <div className="network-addresses-tool__tabs" role="tablist" aria-label={t("networkAddresses.tabs.label")}>
        <button id="network-addresses-tab-live" type="button" role="tab" aria-selected={view === "live"} aria-controls="network-addresses-panel-live" className={view === "live" ? "is-active" : ""} onClick={() => setView("live")}>{t("networkAddresses.tabs.live")}</button>
        <button id="network-addresses-tab-ifconfig" type="button" role="tab" aria-selected={view === "ifconfig"} aria-controls="network-addresses-panel-ifconfig" className={view === "ifconfig" ? "is-active" : ""} onClick={() => setView("ifconfig")}>{t("networkAddresses.tabs.ifconfig")}</button>
      </div>

      {error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}
      {copyStatus ? <p className="network-addresses-tool__copy-status" role="status">{copyStatus}</p> : null}

      {view === "live" ? (
        <div id="network-addresses-panel-live" role="tabpanel" aria-labelledby="network-addresses-tab-live" tabIndex={0}>
          {snapshot ? <p className="toolbox-hint">{t("networkAddresses.live.sampledAt", { time: new Date(snapshot.sampledAtMs).toLocaleString() })} · {t("networkAddresses.live.interfaceCount", { count: interfaces.length })}{snapshot.interfacesTruncated ? ` ${t("networkAddresses.live.truncated")}` : ""} · {t("networkAddresses.live.noUniqueIp")}</p> : null}
          {interfaces.length > 0 ? <div className="network-addresses-tool__actions"><button className="button button--secondary" type="button" onClick={() => void copyText(liveSummary, t("networkAddresses.copy.allLabel"))}><Copy size={14} />{t("networkAddresses.copy.all")}</button></div> : null}
          <div className="network-addresses-tool__cards">
            {interfaces.length > 0 ? interfaces.map((item) => <InterfaceCard key={item.name} item={item} onCopy={copyText} t={t} />) : <p className="network-addresses-tool__empty">{loading ? t("networkAddresses.live.reading") : t("networkAddresses.live.empty")}</p>}
          </div>
        </div>
      ) : (
        <div id="network-addresses-panel-ifconfig" role="tabpanel" aria-labelledby="network-addresses-tab-ifconfig" tabIndex={0} className="network-addresses-tool__paste">
          <textarea className="toolbox-input toolbox-input--code" value={ifconfigInput} onChange={(event) => setIfconfigInput(event.target.value)} placeholder={t("networkAddresses.paste.placeholder")} aria-label={t("networkAddresses.paste.inputLabel")} />
          <div className="network-addresses-tool__actions"><button className="button button--primary" type="button" onClick={parsePastedIfconfig}><Network size={14} />{t("networkAddresses.paste.parse")}</button>{ifconfigInterfaces ? <button className="button button--secondary" type="button" onClick={() => void copyText(ifconfigInterfaces.map((item) => interfaceSummary(item, t)).join("\n\n"), t("networkAddresses.copy.parsedLabel"))}><Copy size={14} />{t("networkAddresses.copy.parsed")}</button> : null}</div>
          <p className="toolbox-hint">{t("networkAddresses.paste.limits")}</p>
          {ifconfigInterfaces ? <div className="network-addresses-tool__cards">{ifconfigInterfaces.length > 0 ? ifconfigInterfaces.map((item) => <InterfaceCard key={item.name} item={item} onCopy={copyText} t={t} />) : <p className="network-addresses-tool__empty">{t("networkAddresses.paste.empty")}</p>}</div> : null}
        </div>
      )}
    </section>
  );
}

function InterfaceCard({ item, onCopy, t }: { item: ParsedInterface; onCopy: (text: string, label: string) => Promise<void>; t: ToolboxTFunction }) {
  return (
    <article className="network-address-card">
      <header className="network-address-card__header">
        <div><h3>{item.name}</h3><span>{item.state ? t("networkAddresses.interface.stateValue", { state: item.state }) : t("networkAddresses.interface.unknownState")}</span></div>
        <button className="button button--secondary" type="button" onClick={() => void onCopy(interfaceSummary(item, t), `${item.name} ${t("networkAddresses.copy.summarySuffix")}`)}><Copy size={14} />{t("networkAddresses.copy.card")}</button>
      </header>
      <dl className="network-address-card__meta"><div><dt>{t("networkAddresses.interface.mtu")}</dt><dd>{item.mtu ?? t("networkAddresses.interface.unknown")}</dd></div><div><dt>{t("networkAddresses.interface.mac")}</dt><dd>{item.mac ?? t("networkAddresses.interface.noMac")}</dd></div><div><dt>{t("networkAddresses.interface.addressCountLabel")}</dt><dd>{item.addresses.length}{item.addressesTruncated ? ` ${t("networkAddresses.interface.truncated")}` : ""}</dd></div>{item.unknownLines > 0 ? <div><dt>{t("networkAddresses.interface.unknownLines")}</dt><dd>{item.unknownLines}</dd></div> : null}</dl>
      {item.addresses.length > 0 ? <ul className="network-address-card__addresses">{item.addresses.map((address) => <AddressRow key={`${address.family}-${address.address}-${address.prefix ?? "none"}-${address.scope ?? ""}`} address={address} onCopy={onCopy} t={t} />)}</ul> : <p className="network-address-card__empty">{t("networkAddresses.interface.noAddress")}</p>}
    </article>
  );
}

function AddressRow({ address, onCopy, t }: { address: ParsedAddress; onCopy: (text: string, label: string) => Promise<void>; t: ToolboxTFunction }) {
  const display = `${address.address}${address.scope ? `%${address.scope}` : ""}${address.prefix === null ? "" : `/${address.prefix}`}`;
  return <li className="network-address-row"><div className="network-address-row__top"><code>{display}</code><span className={`network-address-row__classification is-${address.classification}`}>{t(CLASSIFICATION_KEYS[address.classification])}</span><button className="icon-button" type="button" aria-label={t("networkAddresses.copy.addressAria", { address: display })} onClick={() => void onCopy(display, t("networkAddresses.copy.addressLabel"))}><Copy size={14} /></button></div><div className="network-address-row__details"><span>{t(FAMILY_KEYS[address.family])}</span>{address.mask ? <span>{t("networkAddresses.address.mask")} {address.mask}</span> : null}{address.network ? <span>{t("networkAddresses.address.network")} {address.network}</span> : null}{address.broadcast ? <span>{t("networkAddresses.address.broadcast")} {address.broadcast}</span> : address.family === "ipv4" && address.prefix !== null ? <span>{t("networkAddresses.address.noBroadcastFormula")}</span> : null}{address.scope ? <span>{t("networkAddresses.address.scope")} {address.scope}</span> : null}</div><p>{t(EXPLANATION_KEYS[address.family][address.classification])}</p></li>;
}

function interfaceSummary(item: ParsedInterface, t: ToolboxTFunction): string {
  const lines = [
    `${t("networkAddresses.interface.name")}: ${item.name}`,
    `${t("networkAddresses.interface.state")}: ${item.state ?? t("networkAddresses.interface.unknown")}`,
    `${t("networkAddresses.interface.mtu")}: ${item.mtu ?? t("networkAddresses.interface.unknown")}`,
    `${t("networkAddresses.interface.mac")}: ${item.mac ?? t("networkAddresses.interface.noMac")}`,
  ];
  for (const address of item.addresses) lines.push(`${t("networkAddresses.address.label")}: ${address.address}${address.scope ? `%${address.scope}` : ""}${address.prefix === null ? "" : `/${address.prefix}`} · ${t(CLASSIFICATION_KEYS[address.classification])}${address.network ? ` · ${t("networkAddresses.address.network")} ${address.network}` : ""}`);
  return lines.join("\n");
}
