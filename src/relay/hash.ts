import { createHash } from "node:crypto";

export function topicHash(baseUrl: string, topic: string): string {
  return createHash("sha256").update(`${baseUrl}/${topic}`).digest("hex");
}
