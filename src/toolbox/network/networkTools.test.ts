import { describe, expect, it } from "vitest";
import { ToolboxInputError } from "../local/toolboxErrors";
import { parseIfconfig, parseNetworkInterfaceSnapshot, parseSnapshotAddress } from "./networkTools";

describe("ifconfig parser", () => {
  it("parses BSD and Linux fields without executing anything", () => {
    const result = parseIfconfig("en0: flags=8863 mtu 1500\n\tinet 192.168.1.5 netmask 0xffffff00\n\tinet6 fe80::1%en0 prefixlen 64\n\tether aa:bb:cc:dd:ee:ff\n");
    expect(result[0]).toMatchObject({ name: "en0", mtu: 1500, mac: "aa:bb:cc:dd:ee:ff" });
    expect(result[0].addresses[0]).toMatchObject({ prefix: 24, mask: "255.255.255.0", network: "192.168.1.0", broadcast: "192.168.1.255", classification: "private" });
    expect(result[0].addresses[1]).toMatchObject({ family: "ipv6", scope: "en0", classification: "link-local", network: "fe80::" });
  });

  it("does not apply a broadcast formula to /31 or /32", () => {
    const result = parseIfconfig("eth0: flags=1\n inet 10.0.0.1 netmask 255.255.255.254\n");
    expect(result[0].addresses[0].broadcast).toBeNull();
    expect(result[0].addresses[0].network).toBe("10.0.0.0");
  });

  it("strictly validates IPv4, compressed IPv6, prefixes, and non-contiguous masks", () => {
    expect(parseSnapshotAddress("2001:db8::abcd/64")).toMatchObject({
      family: "ipv6",
      network: "2001:db8::",
      classification: "documentation",
    });
    expect(parseSnapshotAddress("100.64.1.2/10").classification).toBe("shared");
    expect(() => parseIfconfig("en0: flags=1\n inet 999.1.1.1 netmask 255.255.255.0\n")).toThrow(ToolboxInputError);
    expect(() => parseIfconfig("en0: flags=1\n inet 10.0.0.1 netmask 255.0.255.0\n")).toThrow("连续掩码");
    expect(() => parseSnapshotAddress("2001:::1/64")).toThrow("IP 地址格式无效");
    expect(() => parseSnapshotAddress("192.168.1.1/33")).toThrow("前缀长度无效");
  });

  it("keeps unknown lines visible and preserves Linux interface headers and IPv6 scope ids", () => {
    const result = parseIfconfig("2: eth0: <BROADCAST,UP> mtu 1500 state UP\n\tinet 10.0.0.2/24\n\tinet6 fe80::2 prefixlen 64 scopeid 0x20\n\tcarrier_changes 2\n");
    expect(result[0]).toMatchObject({ name: "eth0", mtu: 1500, state: "UP", unknownLines: 1 });
    expect(result[0].addresses[0].prefix).toBe(24);
    expect(result[0].addresses[1].scope).toBe("0x20");
  });

  it("enforces bounded input and per-interface/interface counts", () => {
    expect(() => parseIfconfig("x".repeat(256 * 1024 + 1))).toThrow("256 KiB");
    const addresses = Array.from({ length: 65 }, (_, index) => `\tinet 10.0.0.${(index % 254) + 1}/32`).join("\n");
    expect(() => parseIfconfig(`en0: flags=1\n${addresses}\n`)).toThrow("64");
    const interfaces = Array.from({ length: 129 }, (_, index) => `en${index}: flags=1`).join("\n");
    expect(() => parseIfconfig(interfaces)).toThrow("128");
  });

  it("uses the same address explanations for a live snapshot without adding traffic fields", () => {
    const result = parseNetworkInterfaceSnapshot({
      name: "utun7",
      mtu: 1280,
      macAddress: null,
      ipNetworks: ["10.1.2.3/16", "fc00::12/7"],
      operationalState: "up",
    });
    expect(result).toMatchObject({ name: "utun7", mtu: 1280, state: "up" });
    expect(result.addresses.map((address) => address.classification)).toEqual(["private", "unique-local"]);
  });
});
