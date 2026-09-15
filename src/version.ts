import { readFileSync } from "node:fs";

// The binary's version, read from package.json so it cannot drift from the
// image tag. tsx runs the TypeScript in place, in dev and in the image alike,
// so package.json is always one level up from this file.
export const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
