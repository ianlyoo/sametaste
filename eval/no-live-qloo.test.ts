/**
 * No live Qloo data in the repository (Qloo's terms: private server-side
 * caching only, never a public repository). Live recordings live in the
 * server's KV and .recordings/ (lib/agent/recordings.ts); every tracked file
 * must hold mock data only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SNAPSHOTS } from "../personas/snapshots";
import { LIVE_QLOO_ID_HASHES } from "./live-qloo-ids";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".recordings", ".scratch", ".vercel", "coverage"]);
const BINARY = /\.(png|jpe?g|webp|avif|gif|ico|glb|gltf|hdr|exr|ktx2|bin|woff2?|ttf|otf|mp4|webm|pdf|zip|gz)$/i;

/** Tracked files (git ls-files), else every file outside the ignored directories (an export without .git). */
function repoFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
        } else out.push(join(dir, e.name).replace(/^\.\//, ""));
      }
    };
    walk(".");
    return out;
  }
}

// a recording's run_started on live Qloo, as JSON or inside a JSON string (personas/snapshots); spelled in pieces so this file doesn't match
const LIVE_RUN = new RegExp(["\\\\?", '"', "qlooMock", "\\\\?", '"', ":\\s*", "false"].join(""));
const UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;
const live = new Set(LIVE_QLOO_ID_HASHES);
const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

describe("no live Qloo data in the repository", () => {
  const files = repoFiles().filter((f) => !BINARY.test(f) && statSync(f, { throwIfNoEntry: false })?.isFile());

  it("knows the live set it guards against", () => {
    expect(live.size).toBeGreaterThan(50);
    expect(files.length).toBeGreaterThan(50);
  });

  it("no tracked file holds a live-Qloo recording", () => {
    const hits = files.filter((f) => LIVE_RUN.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("no tracked file holds a Qloo entity id from the live recordings", () => {
    const hits = files.flatMap((f) => [...new Set(readFileSync(f, "utf8").match(UUID) ?? [])].filter((id) => live.has(hash(id))).map((id) => `${f}: ${hash(id)}`));
    expect(hits).toEqual([]);
  });

  it("the bundled persona snapshots are mock recordings", () => {
    for (const snap of Object.values(SNAPSHOTS)) {
      expect(snap.qlooMock, snap.personaId).toBe(true);
      const started = snap.sametaste[0];
      expect(started.type === "run_started" && started.qlooMock, snap.personaId).toBe(true);
    }
  });
});
