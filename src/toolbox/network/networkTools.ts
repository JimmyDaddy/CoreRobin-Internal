import { ToolboxInputError } from "../local/toolboxErrors";

export type AddressClassification =
  | "unspecified"
  | "loopback"
  | "private"
  | "unique-local"
  | "link-local"
  | "multicast"
  | "shared"
  | "documentation"
  | "ipv4-mapped"
  | "global-unicast"
  | "reserved";

export interface ParsedAddress {
  family: "ipv4" | "ipv6";
  address: string;
  prefix: number | null;
  mask: string | null;
  network: string | null;
  broadcast: string | null;
  scope: string | null;
  classification: AddressClassification;
  explanation: string;
}

export interface ParsedInterface {
  name: string;
  addresses: ParsedAddress[];
  mac: string | null;
  mtu: number | null;
  state: string | null;
  unknownLines: number;
  addressesTruncated?: boolean;
}

export interface NetworkAddressInterfaceSnapshot {
  name: string;
  mtu: number;
  macAddress: string | null;
  ipNetworks: string[];
  operationalState: string;
  addressesTruncated?: boolean;
}

export interface NetworkAddressesSnapshot {
  sampledAtMs: number;
  interfaces: NetworkAddressInterfaceSnapshot[];
  interfacesTruncated?: boolean;
}

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INTERFACES = 128;
const MAX_ADDRESSES_PER_INTERFACE = 64;

const INTERFACE_LINE_KEYWORDS = new Set(["inet", "inet6", "ether", "lladdr", "hwaddr", "status", "state", "media", "nd6", "options"]);

interface ParsedIp {
  family: "ipv4" | "ipv6";
  address: string;
  octets?: number[];
  words?: number[];
  zone: string | null;
}

interface ParsedToken {
  ip: ParsedIp;
  prefix: number | null;
}

/** Parse one sysinfo-style `address/prefix` value from the live snapshot. */
export function parseSnapshotAddress(value: string): ParsedAddress {
  return makeParsedAddress(parseAddressToken(value), undefined);
}

/** Convert a live interface snapshot into the same display model as ifconfig input. */
export function parseNetworkInterfaceSnapshot(snapshot: NetworkAddressInterfaceSnapshot): ParsedInterface {
  if (!snapshot.name || snapshot.name.length > 255) {
    throw new ToolboxInputError("invalid_interface", "本机网卡名称无效。 ");
  }
  if (!Number.isSafeInteger(snapshot.mtu) || snapshot.mtu < 0) {
    throw new ToolboxInputError("invalid_mtu", "本机网卡 MTU 无效。 ");
  }
  if (snapshot.ipNetworks.length > MAX_ADDRESSES_PER_INTERFACE) {
    throw new ToolboxInputError("too_many_addresses", `接口 ${snapshot.name} 的地址数量超过 ${MAX_ADDRESSES_PER_INTERFACE} 个上限。 `);
  }
  const mac = snapshot.macAddress === null ? null : parseMac(snapshot.macAddress, snapshot.name);
  return {
    name: snapshot.name,
    addresses: snapshot.ipNetworks.map(parseSnapshotAddress),
    mac,
    mtu: snapshot.mtu,
    state: snapshot.operationalState || null,
    unknownLines: 0,
    addressesTruncated: snapshot.addressesTruncated,
  };
}

export function parseIfconfig(input: string): ParsedInterface[] {
  if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) {
    throw new ToolboxInputError("ifconfig_too_large", "ifconfig 文本不能超过 256 KiB。 ");
  }

  const interfaces: ParsedInterface[] = [];
  let current: ParsedInterface | null = null;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const name = parseInterfaceHeader(line);
    let recognized = name !== null;
    if (name !== null) {
      if (interfaces.length >= MAX_INTERFACES) {
        throw new ToolboxInputError("ifconfig_too_many_interfaces", `接口数量不能超过 ${MAX_INTERFACES} 个。 `);
      }
      current = { name, addresses: [], mac: null, mtu: null, state: null, unknownLines: 0 };
      interfaces.push(current);
    }
    if (!current) continue;

    const ipv6 = line.match(/\binet6\s+(\S+)/i);
    if (ipv6) {
      const prefix = parsePrefixToken(line.match(/\bprefixlen\s+(\S+)/i)?.[1]);
      const scope = line.match(/\bscopeid\s+(\S+)/i)?.[1] ?? undefined;
      addAddress(current, parseAddressToken(ipv6[1], prefix, scope));
      continue;
    }

    const ipv4 = line.match(/\binet\s+(\S+)/i);
    if (ipv4) {
      const netmask = line.match(/\bnetmask\s+(\S+)/i)?.[1];
      const prefix = netmask === undefined ? undefined : parseNetmask(netmask);
      addAddress(current, parseAddressToken(ipv4[1], prefix));
      continue;
    }

    const mac = line.match(/\b(?:ether|lladdr|hwaddr)\s+(\S+)/i);
    if (mac) {
      recognized = true;
      current.mac = parseMac(mac[1], current.name);
    }

    const mtu = line.match(/\bmtu\s+(\S+)/i);
    if (mtu) {
      recognized = true;
      if (!/^\d+$/.test(mtu[1])) throw new ToolboxInputError("invalid_mtu", `接口 ${current.name} 的 MTU 无效。 `);
      const value = Number(mtu[1]);
      if (!Number.isSafeInteger(value) || value < 0) throw new ToolboxInputError("invalid_mtu", `接口 ${current.name} 的 MTU 无效。 `);
      current.mtu = value;
    }

    const state = line.match(/\bstatus:\s*(\S+)/i) ?? line.match(/\bstate\s+(\S+)/i);
    if (state) {
      recognized = true;
      current.state = state[1];
    }

    if (!recognized) current.unknownLines += 1;
  }
  return interfaces;
}

function parseInterfaceHeader(line: string): string | null {
  if (/^\s/.test(line)) return null;
  const linux = line.match(/^\d+:\s+([^\s:]+):(?:\s|$)/);
  if (linux) return linux[1];
  const standard = line.match(/^([^\s:]+):(?:\s|$)/);
  if (!standard || INTERFACE_LINE_KEYWORDS.has(standard[1].toLowerCase())) return null;
  return standard[1];
}

function addAddress(target: ParsedInterface, token: ParsedToken): void {
  if (target.addresses.length >= MAX_ADDRESSES_PER_INTERFACE) {
    throw new ToolboxInputError("ifconfig_too_many_addresses", `接口 ${target.name} 的地址数量不能超过 ${MAX_ADDRESSES_PER_INTERFACE} 个。 `);
  }
  target.addresses.push(makeParsedAddress(token));
}

function parseAddressToken(value: string, prefixOverride?: number, scopeOverride?: string): ParsedToken {
  const slash = value.indexOf("/");
  if (slash !== -1 && slash !== value.lastIndexOf("/")) {
    throw new ToolboxInputError("invalid_prefix", "IP 地址前缀格式无效。 ");
  }
  const addressValue = slash === -1 ? value : value.slice(0, slash);
  let tokenPrefix: number | null = null;
  if (slash !== -1) {
    const parsedPrefix = parsePrefixToken(value.slice(slash + 1));
    if (parsedPrefix === undefined) throw new ToolboxInputError("invalid_prefix", "IP 地址前缀长度无效。 ");
    tokenPrefix = parsedPrefix;
  }
  if (!addressValue) throw new ToolboxInputError("invalid_ip", "IP 地址不能为空。 ");

  const zoneIndex = addressValue.indexOf("%");
  const address = zoneIndex === -1 ? addressValue : addressValue.slice(0, zoneIndex);
  const zone = zoneIndex === -1 ? null : addressValue.slice(zoneIndex + 1);
  if (zoneIndex !== -1 && (!zone || !/^[A-Za-z0-9_.-]+$/.test(zone))) {
    throw new ToolboxInputError("invalid_ipv6_zone", "IPv6 zone/scope 格式无效。 ");
  }

  const octets = parseIpv4(address);
  const words = octets === null ? parseIpv6(address) : null;
  if (octets === null && words === null) throw new ToolboxInputError("invalid_ip", "IP 地址格式无效。 ");
  if (octets && zone !== null) throw new ToolboxInputError("invalid_ipv4_zone", "IPv4 地址不能带 IPv6 zone/scope。 ");

  const family = octets !== null ? "ipv4" : "ipv6";
  const maxPrefix = family === "ipv4" ? 32 : 128;
  if (prefixOverride !== undefined && (prefixOverride < 0 || prefixOverride > maxPrefix)) {
    throw new ToolboxInputError(family === "ipv4" ? "invalid_ipv4_prefix" : "invalid_ipv6_prefix", "IP 地址前缀长度无效。 ");
  }
  if (tokenPrefix !== null && (tokenPrefix < 0 || tokenPrefix > maxPrefix)) {
    throw new ToolboxInputError(family === "ipv4" ? "invalid_ipv4_prefix" : "invalid_ipv6_prefix", "IP 地址前缀长度无效。 ");
  }
  if (prefixOverride !== undefined && tokenPrefix !== null && prefixOverride !== tokenPrefix) {
    throw new ToolboxInputError("conflicting_prefix", "IP 地址中的前缀与网卡字段不一致。 ");
  }
  return {
    ip: { family, address, octets: octets ?? undefined, words: words ?? undefined, zone: zone ?? scopeOverride ?? null },
    prefix: tokenPrefix ?? prefixOverride ?? null,
  };
}

function parsePrefixToken(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new ToolboxInputError("invalid_prefix", "IP 地址前缀长度必须是数字。 ");
  const prefix = Number(value);
  if (!Number.isSafeInteger(prefix)) throw new ToolboxInputError("invalid_prefix", "IP 地址前缀长度无效。 ");
  return prefix;
}

function parseNetmask(value: string): number {
  let mask: number;
  if (/^0x[0-9a-f]{1,8}$/i.test(value)) {
    mask = Number.parseInt(value.slice(2), 16) >>> 0;
  } else {
    const octets = value.split(".");
    if (octets.length !== 4 || octets.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) {
      throw new ToolboxInputError("invalid_netmask", "IPv4 掩码格式无效。 ");
    }
    const parsed = octets.map(Number);
    if (parsed.some((octet) => octet > 255)) throw new ToolboxInputError("invalid_netmask", "IPv4 掩码格式无效。 ");
    mask = parsed.reduce((result, octet) => result * 256 + octet, 0) >>> 0;
  }
  return prefixFromMask(mask);
}

function prefixFromMask(mask: number): number {
  let prefix = 0;
  let bit = 0x80000000;
  while ((mask & bit) !== 0) {
    prefix += 1;
    bit >>>= 1;
  }
  if (bit === 0) return 32;
  if ((mask & (bit - 1)) !== 0) throw new ToolboxInputError("non_contiguous_netmask", "IPv4 掩码必须是连续掩码。 ");
  return prefix;
}

function parseIpv4(value: string): number[] | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const octets = value.split(".").map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(":")) return null;
  let address = value;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = parseIpv4(address.slice(lastColon + 1));
    if (!embedded) return null;
    const hex = `${((embedded[0] << 8) | embedded[1]).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
    address = `${address.slice(0, lastColon)}:${hex}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (halves.length === 2 && missing < 1) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  return [...left.map((part) => Number.parseInt(part, 16)), ...Array.from({ length: missing }, () => 0), ...right.map((part) => Number.parseInt(part, 16))];
}

function parseMac(value: string, interfaceName: string): string {
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) {
    throw new ToolboxInputError("invalid_mac", `接口 ${interfaceName} 的 MAC 地址格式无效。 `);
  }
  return value.toLowerCase();
}

function makeParsedAddress(token: ParsedToken, scopeOverride?: string): ParsedAddress {
  const scope = token.ip.zone ?? scopeOverride ?? null;
  if (token.ip.family === "ipv4") {
    const octets = token.ip.octets!;
    const numeric = ipv4ToNumber(octets);
    const network = token.prefix === null ? null : ipv4ToString(ipv4NetworkNumber(numeric, token.prefix));
    const mask = token.prefix === null ? null : ipv4ToString(ipv4MaskNumber(token.prefix));
    return {
      family: "ipv4",
      address: token.ip.address,
      prefix: token.prefix,
      mask,
      network,
      broadcast: token.prefix === null || token.prefix >= 31 ? null : ipv4ToString(ipv4BroadcastNumber(numeric, token.prefix)),
      scope,
      ...classifyIpv4(numeric),
    };
  }

  const words = token.ip.words!;
  return {
    family: "ipv6",
    address: token.ip.address,
    prefix: token.prefix,
    mask: null,
    network: token.prefix === null ? null : wordsToIpv6(ipv6NetworkWords(words, token.prefix)),
    broadcast: null,
    scope,
    ...classifyIpv6(words),
  };
}

function ipv4ToNumber(octets: number[]): number {
  return octets[0] * 16_777_216 + octets[1] * 65_536 + octets[2] * 256 + octets[3];
}

function ipv4ToString(value: number): string {
  return [Math.floor(value / 16_777_216), Math.floor(value / 65_536) % 256, Math.floor(value / 256) % 256, value % 256].join(".");
}

function ipv4MaskNumber(prefix: number): number {
  return prefix === 0 ? 0 : 4_294_967_296 - 2 ** (32 - prefix);
}

function ipv4NetworkNumber(value: number, prefix: number): number {
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(value / blockSize) * blockSize;
}

function ipv4BroadcastNumber(value: number, prefix: number): number {
  return ipv4NetworkNumber(value, prefix) + 2 ** (32 - prefix) - 1;
}

function ipv6NetworkWords(words: number[], prefix: number): number[] {
  return words.map((word, index) => {
    const remaining = prefix - index * 16;
    if (remaining >= 16) return word;
    if (remaining <= 0) return 0;
    return word & (0xffff << (16 - remaining));
  });
}

function wordsToIpv6(words: number[]): string {
  const parts = words.map((word) => word.toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < parts.length;) {
    if (parts[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < parts.length && parts[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart === -1) return parts.join(":");
  const left = parts.slice(0, bestStart).join(":");
  const right = parts.slice(bestStart + bestLength).join(":");
  if (!left && !right) return "::";
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

function classifyIpv4(value: number): Pick<ParsedAddress, "classification" | "explanation"> {
  if (value === 0) return { classification: "unspecified", explanation: "未指定地址，不表示可访问的接口地址。" };
  if (ipv4InRange(value, 0x7f000000, 8)) return { classification: "loopback", explanation: "回环地址，只在本机内部使用。" };
  if (ipv4InRange(value, 0x0a000000, 8) || ipv4InRange(value, 0xac100000, 12) || ipv4InRange(value, 0xc0a80000, 16)) return { classification: "private", explanation: "RFC1918 私网地址；这里不代表已确认网络连通。" };
  if (ipv4InRange(value, 0xa9fe0000, 16)) return { classification: "link-local", explanation: "IPv4 链路本地地址，通常只在本地链路有效。" };
  if (ipv4InRange(value, 0x64400000, 10)) return { classification: "shared", explanation: "运营商级共享地址（100.64.0.0/10），不等同于公网出口。" };
  if (ipv4InRange(value, 0xe0000000, 4)) return { classification: "multicast", explanation: "IPv4 多播地址，不是普通单播主机地址。" };
  if (ipv4InRange(value, 0xc0000200, 24) || ipv4InRange(value, 0xc6336400, 24) || ipv4InRange(value, 0xcb007100, 24)) return { classification: "documentation", explanation: "文档示例地址（TEST-NET），不应当作真实公网身份。" };
  if (ipv4InRange(value, 0xf0000000, 4) || ipv4InRange(value, 0, 8)) return { classification: "reserved", explanation: "IPv4 特殊/保留地址，不能据此推断公网可达性。" };
  return { classification: "global-unicast", explanation: "IPv4 全局单播范围；未探测公网出口，也未确认连通性。" };
}

function classifyIpv6(words: number[]): Pick<ParsedAddress, "classification" | "explanation"> {
  if (words.every((word) => word === 0)) return { classification: "unspecified", explanation: "未指定地址，不表示可访问的接口地址。" };
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return { classification: "loopback", explanation: "回环地址，只在本机内部使用。" };
  if (ipv6InRange(words, "fe80::", 10)) return { classification: "link-local", explanation: "IPv6 链路本地地址；zone/scope 只说明本地接口范围。" };
  if (ipv6InRange(words, "fc00::", 7)) return { classification: "unique-local", explanation: "IPv6 唯一本地地址（ULA），不等同于已确认的公网地址。" };
  if (ipv6InRange(words, "ff00::", 8)) return { classification: "multicast", explanation: "IPv6 多播地址，不是普通单播主机地址。" };
  if (ipv6InRange(words, "::ffff:0:0", 96)) return { classification: "ipv4-mapped", explanation: "IPv4 映射地址，用于表示 IPv4，不是独立的 IPv6 链路。" };
  if (ipv6InRange(words, "2001:db8::", 32)) return { classification: "documentation", explanation: "IPv6 文档示例地址，不应当作真实公网身份。" };
  if (ipv6InRange(words, "2000::", 3)) return { classification: "global-unicast", explanation: "IPv6 全局单播范围；未探测公网出口，也未确认连通性。" };
  return { classification: "reserved", explanation: "IPv6 特殊/保留地址，不能据此推断公网可达性。" };
}

function ipv4InRange(value: number, base: number, prefix: number): boolean {
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(value / blockSize) === Math.floor(base / blockSize);
}

function ipv6InRange(words: number[], base: string, prefix: number): boolean {
  const parsed = parseIpv6(base);
  if (!parsed) return false;
  const wholeWords = Math.floor(prefix / 16);
  for (let index = 0; index < wholeWords; index += 1) if (words[index] !== parsed[index]) return false;
  const remaining = prefix % 16;
  return remaining === 0 || (words[wholeWords] & (0xffff << (16 - remaining))) === (parsed[wholeWords] & (0xffff << (16 - remaining)));
}
