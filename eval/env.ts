/**
 * Loads .env.local for the CLI without printing anything. A variable that is
 * already set to a non-empty value wins; an empty one is filled from the file.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function loadLocalEnv(file = ".env.local") {
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]?.trim()) process.env[k] = v;
  }
}
