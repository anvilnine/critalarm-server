import { describe, expect, it } from "vitest";
import { parseBaseUrl } from "../base-url.js";

const good = ["https://alerts.example.com", "https://alerts.example.com/crit", "https://a.b.example.com:8443/x/y", "https://alerts.example.com:443", "https://alerts.example.com:8443", "https://alerts.example.com/a..b/.hidden/v1.2", "https://Alerts.Example.com"];
const bad: [string, string][] = [
  ["http://alerts.example.com", "not https"],
  ["alerts.example.com", "no scheme"],
  ["https://127.0.0.1", "IPv4 literal"],
  ["https://10.0.0.5:8443", "IPv4 literal with port"],
  ["https://[::1]", "IPv6 literal"],
  ["https://1.2.3.4.5", "numeric top label"],
  ["https://localhost", "localhost, and no dot"],
  ["https://intranet", "no dot"],
  ["https://printer.local", ".local"],
  ["https://app.localhost", ".localhost"],
  ["https://db.internal", ".internal"],
  ["https://nas.lan", ".lan"],
  ["https://box.home.arpa", ".home.arpa"],
  ["https://user@alerts.example.com", "user name"],
  ["https://user:pass@alerts.example.com", "user name and password"],
  ["https://alerts.example.com?x=1", "query"],
  ["https://alerts.example.com/a?x=1", "query on a path"],
  ["https://alerts.example.com#top", "fragment"],
  ["https://alerts.example.com/", "trailing slash"],
  ["https://alerts.example.com/crit/", "trailing slash on a path"],
  ["https://alerts.example.com:0", "port 0"],
  ["https://alerts.example.com:99999", "port too large"],
  ["https://alerts.example.com:80", "port 80"],
  ["https://alerts.example.com:8080", "port 8080"],
  ["https://alerts.example.com:4430", "port that starts with 443"],
  ["https://alerts.example.com:84433", "port that starts with 8443"],
  ["https://alerts.example.com:", "empty port"],
  ["https://alerts.example.com/.", "dot segment"],
  ["https://alerts.example.com/..", "dot-dot segment"],
  ["https://alerts.example.com/crit/../admin", "dot-dot segment inside a path"],
  ["https://alerts.example.com/./crit", "dot segment at the start"],
  ["https://alerts..example.com", "empty label"],
  ["https://alerts.example.com.", "trailing dot"],
  ["https://-a.example.com", "label starts with a dash"],
  [`https://${"a".repeat(190)}.example.com`, "over 200 characters"],
  ["https://alerts.example.com\\evil", "backslash"],
  ["https://alerts.example.com/a b", "space"],
  ["", "empty"],
];

describe("parseBaseUrl", () => {
  it.each(good)("accepts %s", (url) => { expect(parseBaseUrl(url)).toBeDefined(); });
  it.each(bad)("refuses %s (%s)", (url) => { expect(parseBaseUrl(url)).toBeUndefined(); });

  it("accepts exactly 200 characters and refuses 201", () => {
    const pad = (n: number) => `https://a.example.com/${"p".repeat(n - "https://a.example.com/".length)}`;
    expect(pad(200)).toHaveLength(200);
    expect(parseBaseUrl(pad(200))).toBeDefined();
    expect(parseBaseUrl(pad(201))).toBeUndefined();
  });

  it("splits host, port and path", () => {
    expect(parseBaseUrl("https://Alerts.Example.com:8443/crit/v2")).toEqual({ host: "alerts.example.com", port: 8443, path: "/crit/v2" });
    expect(parseBaseUrl("https://alerts.example.com")).toEqual({ host: "alerts.example.com", port: 443, path: "" });
  });
});
