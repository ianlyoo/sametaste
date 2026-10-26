/**
 * The local copy of a live recording (eval:record-demo, eval:upload-recording):
 * the files the replay serves, in a directory git ignores (.recordings/).
 * Live Qloo responses never go in tracked files (lib/agent/recordings.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredRecording } from "../lib/agent/recordings";

export const LOCAL_RECORDINGS = ".recordings";

/** Throws unless git ignores `dir` (so a live recording can't be committed by accident). */
export function assertIgnored(dir: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", join(dir, "x.ndjson")], { stdio: "ignore" });
  } catch {
    throw new Error(`${dir} is not ignored by git; live Qloo recordings only go under ${LOCAL_RECORDINGS}/`);
  }
}

export function writeLocalRecording(dir: string, rec: StoredRecording): void {
  assertIgnored(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { parts, ...head } = rec;
  writeFileSync(join(dir, "sametaste.ndjson"), parts.sametaste, { mode: 0o600 });
  writeFileSync(join(dir, "llm_only.ndjson"), parts.llm_only, { mode: 0o600 });
  writeFileSync(join(dir, "replans.json"), parts.replans, { mode: 0o600 });
  writeFileSync(join(dir, "recording.json"), JSON.stringify(head), { mode: 0o600 });
}

export function readLocalRecording(dir: string): StoredRecording {
  const head = JSON.parse(readFileSync(join(dir, "recording.json"), "utf8")) as Omit<StoredRecording, "parts">;
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { ...head, parts: { sametaste: read("sametaste.ndjson"), llm_only: read("llm_only.ndjson"), replans: read("replans.json") } };
}
