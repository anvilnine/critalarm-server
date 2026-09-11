import { describe, expect, it } from "vitest";
import { ParseError, parseJsonPublish, parsePublishRequest } from "../headers.js";

const aliases = {
  title: ["X-Title", "Title", "ti", "t"],
  priority: ["X-Priority", "Priority", "prio", "p"],
  tags: ["X-Tags", "Tags", "tag", "ta"],
  click: ["X-Click", "Click"],
  markdown: ["X-Markdown", "Markdown", "md"],
} as const;

describe("publish header parser", () => {
  for (const header of aliases.title) {
    it(`normalizes ${header} as title`, async () => {
      const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { [header]: "Database" } }));
      expect(input.title).toBe("Database");
    });
  }

  for (const header of aliases.priority) {
    it(`normalizes ${header} as priority`, async () => {
      const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { [header]: "4" } }));
      expect(input.priority).toBe(4);
    });
  }

  for (const header of aliases.tags) {
    it(`normalizes ${header} as tags`, async () => {
      const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { [header]: "warning, server" } }));
      expect(input.tags).toEqual(["warning", "server"]);
    });
  }

  for (const header of aliases.click) {
    it(`normalizes ${header} as click`, async () => {
      const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { [header]: "https://example.com" } }));
      expect(input.click).toBe("https://example.com");
    });
  }

  for (const header of aliases.markdown) {
    it(`normalizes ${header} as markdown`, async () => {
      const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { [header]: "yes" } }));
      expect(input.markdown).toBe(true);
    });
  }

  it.each([
    ["min", 1],
    ["low", 2],
    ["default", 3],
    ["high", 4],
    ["urgent", 5],
    ["max", 5],
  ])("normalizes priority word %s", async (value, expected) => {
    const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { Priority: value } }));
    expect(input.priority).toBe(expected);
  });

  it("accepts query short names including message", async () => {
    const input = await parsePublishRequest(new Request("https://alerts.example.com/prod?t=Kuma&p=urgent&ta=warning%2Cdb&m=down"));
    expect(input).toMatchObject({ title: "Kuma", priority: 5, tags: ["warning", "db"], message: "down" });
  });

  it("uses headers ahead of conflicting query values", async () => {
    const input = await parsePublishRequest(new Request("https://alerts.example.com/prod?t=query-title&p=1&ta=query-tag&m=query-message", {
      method: "POST",
      headers: { "X-Title": "header-title", "X-Priority": "urgent", "X-Tags": "header-tag" },
      body: "body-message",
    }));
    expect(input).toMatchObject({ title: "header-title", priority: 5, tags: ["header-tag"], message: "query-message" });
  });

  it("treats empty header aliases as absent and falls back to another alias then query", async () => {
    const alias = await parsePublishRequest(new Request("https://alerts.example.com/prod?t=query", { headers: { "X-Title": "", Title: "alias" } }));
    const query = await parsePublishRequest(new Request("https://alerts.example.com/prod?t=query", { headers: { "X-Title": "" } }));
    expect(alias.title).toBe("alias");
    expect(query.title).toBe("query");
  });

  it("uses defaults and accepts case-insensitive header names", async () => {
    const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { "x-pRiOrItY": "low" } }));
    expect(input).toMatchObject({ message: "triggered", priority: 2, tags: [], markdown: false });
    expect(input.title).toBeUndefined();
  });

  it("accepts ignored ntfy fields", async () => {
    const input = await parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { "X-Actions": "view", "X-Attach": "https://x", "X-Filename": "x", "X-Icon": "https://x", "X-Email": "a@b.test", "X-Call": "x", "X-Template": "x", "X-Cache": "no", "X-Firebase": "yes", "X-UnifiedPush": "x" } }));
    expect(input.message).toBe("triggered");
  });

  for (const header of ["X-Delay", "Delay", "X-At", "At", "X-In", "In"]) {
    it(`rejects ${header}`, async () => {
      await expect(parsePublishRequest(new Request("https://alerts.example.com/prod", { headers: { [header]: "10m" } }))).rejects.toEqual(new ParseError(400, "scheduled delivery not supported"));
    });
  }

  it("rejects JSON delay", () => {
    expect(() => parseJsonPublish({ topic: "prod", delay: "10m" })).toThrow(new ParseError(400, "scheduled delivery not supported"));
  });
});
