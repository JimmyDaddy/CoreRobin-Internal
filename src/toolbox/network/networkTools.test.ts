import { describe, expect, it } from "vitest";
import { parseIfconfig } from "./networkTools";

describe("ifconfig parser", () => {
  it("parses BSD and Linux fields without executing anything", () => {
    const result = parseIfconfig("en0: flags=8863 mtu 1500\n\tinet 192.168.1.5 netmask 0xffffff00\n\tinet6 fe80::1%en0 prefixlen 64\n\tether aa:bb:cc:dd:ee:ff\n");
    expect(result[0]).toMatchObject({ name: "en0", mtu: 1500, mac: "aa:bb:cc:dd:ee:ff" });
    expect(result[0].addresses[0]).toMatchObject({ prefix: 24, network: "192.168.1.0", broadcast: "192.168.1.255" });
    expect(result[0].addresses[1]).toMatchObject({ family: "ipv6", scope: "en0" });
  });

  it("does not apply a broadcast formula to /31 or /32", () => {
    const result = parseIfconfig("eth0: flags=1\n inet 10.0.0.1 netmask 255.255.255.254\n");
    expect(result[0].addresses[0].broadcast).toBeNull();
  });
});
