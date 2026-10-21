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

  // The repo is public and so are its workflow logs. Coolify's answers used to
  // be printed there in full.
  it("prints the HTTP status of each Coolify call and never the response body", () => {
    const calls = (deploy?.steps ?? []).filter((step) => /COOLIFY_URL/.test(step.run ?? "") && /\bcurl\b/.test(step.run ?? ""));
    expect(calls.length).toBe(2);
    for (const step of calls) {
      const run = step.run ?? "";
      expect(run).toMatch(/curl [^\n]*-o \/dev\/null/);
      expect(run).toMatch(/echo "HTTP \$status"/);
      expect(run).not.toMatch(/\bcat\b/);
      expect(run).not.toMatch(/\/tmp\//);
    }
  });
});

// A tag like @v4 can be moved to any commit by whoever controls the action's
// repository. A full commit SHA cannot. The comment names the release the SHA
// is, so a reader and Dependabot can tell what it is.
describe("every workflow", () => {
  const files = ["ci.yml", "release.yml"];

  it.each(files)("%s pins each action to a full commit SHA with its version beside it", (name) => {
    const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
    const steps = Object.values(workflow(name).jobs).flatMap((job) => job.steps);
    const uses = steps.map((step) => step.uses).filter((value): value is string => value !== undefined);
    expect(uses.length).toBeGreaterThan(0);
    for (const value of uses) expect(value).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    const lines = text.split("\n").filter((line) => /^\s*(- )?uses:/.test(line));
    expect(lines.length).toBe(uses.length);
    for (const line of lines) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});
