import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The workflows are part of what ships production, so their guards get a test
// like the code does.

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; name?: string };
type Job = { if?: string; needs?: string | string[]; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> };

const workflow = (name: string) => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")) as Workflow;

describe("ci.yml", () => {
  it("gives the token read access to the repository and nothing more", () => {
    expect(workflow("ci.yml").permissions).toEqual({ contents: "read" });
  });
});

describe("release.yml deploy", () => {
  const deploy = workflow("release.yml").jobs.deploy;

  it("checks out enough history to compare the tag with main", () => {
    const checkout = deploy?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  // A v* tag on a commit that never reached main, from a branch nobody
  // reviewed, used to deploy production like any other.
  it("stops unless the tagged commit is on main, before any step that talks to Coolify", () => {
    const steps = deploy?.steps ?? [];
    const guard = steps.findIndex((step) => /git merge-base --is-ancestor\b/.test(step.run ?? "") && /origin\/main/.test(step.run ?? ""));
    const firstCoolify = steps.findIndex((step) => /COOLIFY/.test(step.run ?? ""));
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstCoolify);
    expect(steps[guard]?.run).toMatch(/exit 1/);
  });
});
