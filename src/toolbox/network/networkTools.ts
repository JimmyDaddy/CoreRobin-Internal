import { ToolboxInputError } from "../local/toolboxErrors";

export interface ParsedAddress {
  family: "ipv4" | "ipv6";
  address: string;
  prefix: number | null;
  network: string | null;
  broadcast: string | null;
  scope: string | null;
}

export interface ParsedInterface {
  name: string;
  addresses: ParsedAddress[];
  mac: string | null;
  mtu: number | null;
  state: string | null;
  unknownLines: number;
}

const MAX_INPUT_BYTES = 256 * 1024;

export function parseIfconfig(input: string): ParsedInterface[] {
  if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) throw new ToolboxInputError("ifconfig_too_large", "ifconfig 文本不能超过 256 KiB。 ");
  const interfaces: ParsedInterface[] = [];
  let current: ParsedInterface | null = null;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = line.match(/^([^\s:][^:]*)[:\s]/);
    if (header && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (interfaces.length >= 128) throw new ToolboxInputError("ifconfig_too_many_interfaces", "接口数量超过 128 个上限。 ");
      current = { name: header[1].trim(), addresses: [], mac: null, mtu: null, state: null, unknownLines: 0 };
      interfaces.push(current);
    }
    if (!current) continue;
    const ipv4 = line.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\s+netmask\s+([^\s]+))?/);
    if (ipv4) {
      const prefix = ipv4[2] ? parseNetmask(ipv4[2]) : null;
      addAddress(current, { family: "ipv4", address: ipv4[1], prefix, network: prefix === null ? null : ipv4Network(ipv4[1], prefix), broadcast: prefix !== null && prefix < 31 ? ipv4Broadcast(ipv4[1], prefix) : null, scope: null });
      continue;
    }
    const ipv6 = line.match(/\binet6\s+([^\s%]+)(?:%([^\s]+))?(?:\s+prefixlen\s+(\d+))?/);
    if (ipv6) {
      const prefix = ipv6[3] === undefined ? null : Number.parseInt(ipv6[3], 10);
      if (prefix !== null && (prefix < 0 || prefix > 128)) throw new ToolboxInputError("invalid_ipv6_prefix", "IPv6 前缀长度无效。 ");
      addAddress(current, { family: "ipv6", address: ipv6[1], prefix, network: null, broadcast: null, scope: ipv6[2] ?? null });
      continue;
    }
    const mac = line.match(/\b(?:ether|lladdr)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i);
    if (mac) { current.mac = mac[1].toLowerCase(); continue; }
    const mtu = line.match(/\bmtu\s+(\d+)/i);
    if (mtu) { current.mtu = Number.parseInt(mtu[1], 10); continue; }
    const state = line.match(/\bstatus:\s*([^\s]+)/i) ?? line.match(/\bstate\s+([^\s]+)/i);
    if (state) { current.state = state[1]; continue; }
    current.unknownLines += 1;
  }
  return interfaces;
}

function addAddress(target: ParsedInterface, address: ParsedAddress): void {
  if (!isValidIp(address.address, address.family)) throw new ToolboxInputError("invalid_ip", `接口 ${target.name} 包含无效地址。 `);
  if (target.addresses.length >= 64) throw new ToolboxInputError("ifconfig_too_many_addresses", `接口 ${target.name} 的地址数量超过 64 个上限。 `);
  target.addresses.push(address);
}

function parseNetmask(value: string): number {
  if (/^0x[0-9a-f]{1,8}$/i.test(value)) {
    const number = Number.parseInt(value.slice(2), 16) >>> 0;
    return prefixFromMask(number);
  }
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) throw new ToolboxInputError("invalid_netmask", "IPv4 掩码格式无效。 ");
  return prefixFromMask(((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function prefixFromMask(mask: number): number {
  const binary = mask.toString(2).padStart(32, "0");
  if (!/^1*0*$/.test(binary)) throw new ToolboxInputError("non_contiguous_netmask", "IPv4 掩码必须是连续掩码。 ");
  return binary.indexOf("0") < 0 ? 32 : binary.indexOf("0");
}

function ipv4Parts(address: string): number[] { return address.split(".").map(Number); }
function ipv4Network(address: string, prefix: number): string { const numeric = ipv4Parts(address).reduce((result, part) => ((result << 8) | part) >>> 0, 0); const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return [numeric & mask].map((value) => `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`)[0]; }
function ipv4Broadcast(address: string, prefix: number): string { const numeric = ipv4Parts(address).reduce((result, part) => ((result << 8) | part) >>> 0, 0); const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; const value = (numeric & mask) | (~mask >>> 0); return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`; }
function isValidIp(value: string, family: "ipv4" | "ipv6"): boolean { if (family === "ipv4") return ipv4Parts(value).length === 4 && ipv4Parts(value).every((part) => Number.isInteger(part) && part >= 0 && part <= 255); return value.includes(":") && /^[0-9a-f:]+$/i.test(value); }
