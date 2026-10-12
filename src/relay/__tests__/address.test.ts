import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../address.js";

const refused: [string, string][] = [
  ["0.0.0.0", "0.0.0.0/8"], ["0.255.255.255", "0.0.0.0/8"],
  ["10.0.0.1", "RFC 1918 10/8"], ["172.16.0.1", "RFC 1918 172.16/12"], ["172.31.255.255", "RFC 1918 172.16/12"], ["192.168.1.1", "RFC 1918 192.168/16"],
  ["100.64.0.1", "100.64.0.0/10"], ["100.127.255.255", "100.64.0.0/10"],
  ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"],
  ["169.254.169.254", "169.254.0.0/16"],
  ["192.0.0.8", "192.0.0.0/24"], ["192.0.2.5", "192.0.2.0/24"],
  ["198.18.0.1", "198.18.0.0/15"], ["198.19.255.255", "198.18.0.0/15"],
  ["198.51.100.7", "198.51.100.0/24"], ["203.0.113.9", "203.0.113.0/24"],
  ["224.0.0.1", "multicast"], ["239.255.255.255", "multicast"], ["240.0.0.1", "reserved"], ["255.255.255.255", "broadcast"],
  ["::", "unspecified"], ["::1", "loopback"],
  ["fc00::1", "fc00::/7"], ["fd12:3456::1", "fc00::/7"],
  ["fe80::1", "fe80::/10"], ["febf::1", "fe80::/10"],
  ["ff02::1", "ff00::/8"],
  ["2001:db8::1", "2001:db8::/32"],
  ["::ffff:127.0.0.1", "mapped loopback"], ["::ffff:10.1.2.3", "mapped private"], ["::ffff:7f00:1", "mapped loopback, hex form"],
  ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"], ["64:ff9b::192.168.0.1", "NAT64 of private, dotted form"],
  ["not an address", "garbage"], ["", "empty"], ["999.1.1.1", "bad octet"],
];

const accepted: [string, string][] = [
  ["8.8.8.8", "public v4"], ["1.1.1.1", "public v4"],
  ["100.63.255.255", "just below 100.64/10"], ["100.128.0.1", "just above 100.64/10"],
  ["172.15.255.255", "just below 172.16/12"], ["172.32.0.1", "just above 172.16/12"],
  ["198.17.255.255", "just below 198.18/15"], ["198.20.0.1", "just above 198.18/15"],
  ["169.253.1.1", "next to link-local"], ["223.255.255.255", "last unicast"],
  ["192.0.1.1", "next to 192.0.0/24 and 192.0.2/24"],
  ["2606:4700:4700::1111", "public v6"], ["2001:4860:4860::8888", "public v6"],
  ["::ffff:8.8.8.8", "mapped public"], ["64:ff9b::808:808", "NAT64 of 8.8.8.8"],
  ["2001:db9::1", "next to 2001:db8::/32"],
];

describe("isPublicAddress", () => {
  it.each(refused)("refuses %s (%s)", (address) => { expect(isPublicAddress(address)).toBe(false); });
  it.each(accepted)("accepts %s (%s)", (address) => { expect(isPublicAddress(address)).toBe(true); });
});
