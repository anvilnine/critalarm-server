import { isIP } from "node:net";

// Whether the relay may open a connection to this address while it confirms a
// registration challenge (api.md §4.1). Only addresses on the public internet
// pass. A string that is not an IP address is refused.

function ipv4Octets(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

function publicIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

// Eight 16-bit groups, or undefined when the text is not a valid IPv6 address.
function ipv6Groups(text: string): number[] | undefined {
  let rest = text;
  const zone = rest.indexOf("%");
  if (zone >= 0) rest = rest.slice(0, zone);
  const tail = rest.lastIndexOf(":");
  const dotted = rest.slice(tail + 1).includes(".");
  if (dotted) {
    const v4 = ipv4Octets(rest.slice(tail + 1));
    if (v4 === undefined) return undefined;
    rest = `${rest.slice(0, tail + 1)}${((v4[0] ?? 0) << 8 | (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) << 8 | (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":").map((group) => (/^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
    return groups.some(Number.isNaN) ? undefined : groups;
  };
  const head = parse(halves[0] ?? "");
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const back = parse(halves[1] ?? "");
  if (back === undefined || head.length + back.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - back.length).fill(0), ...back];
}

function embeddedIpv4(groups: readonly number[]): number[] {
  const [g6, g7] = [groups[6] ?? 0, groups[7] ?? 0];
  return [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = ipv4Octets(address);
    return octets !== undefined && publicIpv4(octets);
  }
  if (family !== 6) return false;
  const groups = ipv6Groups(address);
  if (groups === undefined) return false;
  const [g0, g1, g2, g3, g4, g5] = groups as [number, number, number, number, number, number, number, number];
  // :: and ::1.
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1)) return false;
  // ::ffff:a.b.c.d (IPv4-mapped), 64:ff9b::a.b.c.d (NAT64) and ::a.b.c.d (the
  // old IPv4-compatible form) are judged by the IPv4 address inside.
  const zeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (zeros && g4 === 0 && (g5 === 0xffff || g5 === 0)) return publicIpv4(embeddedIpv4(groups));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return publicIpv4(embeddedIpv4(groups));
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32
  return true;
}
