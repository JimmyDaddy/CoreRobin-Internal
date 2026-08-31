import { CircleAlert, Copy, Network, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const CLASSIFICATION_LABELS: Record<AddressClassification, string> = {
  unspecified: "未指定",
  loopback: "回环",
  private: "RFC1918 私网",
  "unique-local": "IPv6 ULA",
  "link-local": "链路本地",
  multicast: "多播",
  shared: "共享地址",
  documentation: "文档示例",
  "ipv4-mapped": "IPv4 映射",
  "global-unicast": "全局单播（未探测）",
  reserved: "特殊/保留",
};

export function NetworkAddressesTool({ loadSnapshot, initialView = "live" }: NetworkAddressesToolProps) {
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
      setError("当前运行环境不支持复制；请手动选择页面中的文本。 ");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`${label}已复制。内容可能包含 IP、MAC 或接口标识，仅在你点击后写入系统剪贴板。`);
    } catch {
      setError("复制失败；页面不会读取或重试系统剪贴板。 ");
    }
  }, []);

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

  const liveSummary = useMemo(() => interfaces.map((item) => interfaceSummary(item)).join("\n\n"), [interfaces]);

  return (
    <section className="network-addresses-tool" aria-labelledby="network-addresses-title">
      <header className="network-addresses-tool__intro">
        <div>
          <span className="toolbox-eyebrow"><Network size={14} />系统与网络</span>
          <h2 id="network-addresses-title">本机网络地址</h2>
          <p>按接口查看地址与范围；本工具不会探测公网、查询 DNS、测试连通性或修改网络配置。</p>
        </div>
        {view === "live" ? <button className="button button--secondary" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} />{loading ? "正在刷新…" : "按需刷新"}</button> : null}
      </header>

      <p className="network-addresses-tool__privacy"><CircleAlert size={15} />IP、IPv6 zone、MAC、接口名称和粘贴原文只在当前页面内存中处理，不会写入历史、诊断摘要或 URL。复制是受用户点击触发的，并会把网络标识交给系统剪贴板。</p>
      <div className="network-addresses-tool__tabs" role="tablist" aria-label="网络地址视图">
        <button id="network-addresses-tab-live" type="button" role="tab" aria-selected={view === "live"} aria-controls="network-addresses-panel-live" className={view === "live" ? "is-active" : ""} onClick={() => setView("live")}>本机网卡</button>
        <button id="network-addresses-tab-ifconfig" type="button" role="tab" aria-selected={view === "ifconfig"} aria-controls="network-addresses-panel-ifconfig" className={view === "ifconfig" ? "is-active" : ""} onClick={() => setView("ifconfig")}>粘贴 ifconfig</button>
      </div>

      {error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}
      {copyStatus ? <p className="network-addresses-tool__copy-status" role="status">{copyStatus}</p> : null}

      {view === "live" ? (
        <div id="network-addresses-panel-live" role="tabpanel" aria-labelledby="network-addresses-tab-live" tabIndex={0}>
          {snapshot ? <p className="toolbox-hint">采样时间：{new Date(snapshot.sampledAtMs).toLocaleString()} · {interfaces.length} 个接口{snapshot.interfacesTruncated ? "（超过 128 个，已截断）" : ""} · 这里不选出所谓“唯一真实 IP”。</p> : null}
          {interfaces.length > 0 ? <div className="network-addresses-tool__actions"><button className="button button--secondary" type="button" onClick={() => void copyText(liveSummary, "全部接口摘要")}><Copy size={14} />复制全部接口摘要</button></div> : null}
          <div className="network-addresses-tool__cards">
            {interfaces.length > 0 ? interfaces.map((item) => <InterfaceCard key={item.name} item={item} onCopy={copyText} />) : <p className="network-addresses-tool__empty">{loading ? "正在读取本机接口…" : "没有返回接口地址。空结果不代表网络不可用。"}</p>}
          </div>
        </div>
      ) : (
        <div id="network-addresses-panel-ifconfig" role="tabpanel" aria-labelledby="network-addresses-tab-ifconfig" tabIndex={0} className="network-addresses-tool__paste">
          <textarea className="toolbox-input toolbox-input--code" value={ifconfigInput} onChange={(event) => setIfconfigInput(event.target.value)} placeholder="粘贴 macOS/BSD 或 Linux ifconfig 文本；只解析，不执行" aria-label="ifconfig 文本" />
          <div className="network-addresses-tool__actions"><button className="button button--primary" type="button" onClick={parsePastedIfconfig}><Network size={14} />严格解析</button>{ifconfigInterfaces ? <button className="button button--secondary" type="button" onClick={() => void copyText(ifconfigInterfaces.map(interfaceSummary).join("\n\n"), "解析摘要")}><Copy size={14} />复制解析摘要</button> : null}</div>
          <p className="toolbox-hint">最多 256 KiB、128 个接口、每接口 64 个地址；IPv4 非连续掩码、非法 IPv4/IPv6、非法 zone 和冲突前缀会拒绝。未知行会在对应接口卡片中计数。</p>
          {ifconfigInterfaces ? <div className="network-addresses-tool__cards">{ifconfigInterfaces.length > 0 ? ifconfigInterfaces.map((item) => <InterfaceCard key={item.name} item={item} onCopy={copyText} />) : <p className="network-addresses-tool__empty">没有识别到接口。请确认粘贴的是 BSD/Linux ifconfig 输出。</p>}</div> : null}
        </div>
      )}
    </section>
  );
}

function InterfaceCard({ item, onCopy }: { item: ParsedInterface; onCopy: (text: string, label: string) => Promise<void> }) {
  return (
    <article className="network-address-card">
      <header className="network-address-card__header">
        <div><h3>{item.name}</h3><span>{item.state ? `状态：${item.state}` : "状态未知"}</span></div>
        <button className="button button--secondary" type="button" onClick={() => void onCopy(interfaceSummary(item), `${item.name} 摘要`)}><Copy size={14} />复制此卡片</button>
      </header>
      <dl className="network-address-card__meta"><div><dt>MTU</dt><dd>{item.mtu ?? "未知"}</dd></div><div><dt>MAC</dt><dd>{item.mac ?? "未提供"}</dd></div><div><dt>地址数</dt><dd>{item.addresses.length}{item.addressesTruncated ? "（已截断）" : ""}</dd></div>{item.unknownLines > 0 ? <div><dt>未知行</dt><dd>{item.unknownLines}</dd></div> : null}</dl>
      {item.addresses.length > 0 ? <ul className="network-address-card__addresses">{item.addresses.map((address) => <AddressRow key={`${address.family}-${address.address}-${address.prefix ?? "none"}-${address.scope ?? ""}`} address={address} onCopy={onCopy} />)}</ul> : <p className="network-address-card__empty">没有地址字段；这不代表接口不可用。</p>}
    </article>
  );
}

function AddressRow({ address, onCopy }: { address: ParsedAddress; onCopy: (text: string, label: string) => Promise<void> }) {
  const display = `${address.address}${address.scope ? `%${address.scope}` : ""}${address.prefix === null ? "" : `/${address.prefix}`}`;
  return <li className="network-address-row"><div className="network-address-row__top"><code>{display}</code><span className={`network-address-row__classification is-${address.classification}`}>{CLASSIFICATION_LABELS[address.classification]}</span><button className="icon-button" type="button" aria-label={`复制地址 ${display}`} onClick={() => void onCopy(display, "地址")}><Copy size={14} /></button></div><div className="network-address-row__details"><span>{address.family === "ipv4" ? "IPv4" : "IPv6"}</span>{address.mask ? <span>掩码 {address.mask}</span> : null}{address.network ? <span>网络 {address.network}</span> : null}{address.broadcast ? <span>广播 {address.broadcast}</span> : address.family === "ipv4" && address.prefix !== null ? <span>/31、/32 不套用广播公式</span> : null}{address.scope ? <span>scope/zone {address.scope}</span> : null}</div><p>{address.explanation}</p></li>;
}

function interfaceSummary(item: ParsedInterface): string {
  const lines = [`接口：${item.name}`, `状态：${item.state ?? "未知"}`, `MTU：${item.mtu ?? "未知"}`, `MAC：${item.mac ?? "未提供"}`];
  for (const address of item.addresses) lines.push(`地址：${address.address}${address.scope ? `%${address.scope}` : ""}${address.prefix === null ? "" : `/${address.prefix}`} · ${CLASSIFICATION_LABELS[address.classification]}${address.network ? ` · 网络 ${address.network}` : ""}`);
  return lines.join("\n");
}
