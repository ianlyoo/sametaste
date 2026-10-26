/**
 * Loads a live persona recording into the server's KV (lib/agent/recordings.ts),
 * where /demo (GET /api/recording) and the `/` fallback replay it from. Live
 * Qloo responses stay out of git; this is how they get to production.
 *
 *   npm run eval:upload-recording -- --from-git 6b629d7          (the recording committed at that sha)
 *   npm run eval:upload-recording -- --dir .recordings/maya-williamsburg
 *   add --dry-run to check everything against an in-memory store instead
 *
 * Reads KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL /
 * _TOKEN) from the environment and never prints them. Validates every event,
 * refuses a mock recording, keeps a gitignored copy in .recordings/, writes,
 * then reads the recording back and compares it byte for byte.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AgentEventSchema } from "../lib/contract";
import { MemoryKV, UpstashKV, type KV } from "../lib/agent/kv";
import { readRecording, RECORDING_PARTS, writeRecording, type StoredRecording } from "../lib/agent/recordings";
import type { PersonaSnapshot } from "../personas/snapshots";
import { PERSONAS } from "../personas";
import { LOCAL_RECORDINGS, readLocalRecording, writeLocalRecording } from "./recording-files";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const url = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)?.trim();
const token = (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)?.trim();
const redact = (s: string) => [url, token].reduce<string>((out, x) => (x && x.length > 6 ? out.split(x).join("[redacted]") : out), s).slice(0, 300);

/** The recording as committed at `rev`: the fixtures served, the snapshot's request and timestamp. */
function fromGit(rev: string, short: string): StoredRecording {
  const persona = PERSONAS.find((p) => p.id.split("-")[0] === short || p.id === short);
  if (!persona) throw new Error(`unknown persona ${short}`);
  const name = persona.id.split("-")[0];
  const show = (path: string) => execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ts = show(`personas/snapshots/${persona.id}.ts`);
  const m = /JSON\.parse\(("(?:[^"\\]|\\.)*")\) as PersonaSnapshot/.exec(ts);
  if (!m) throw new Error(`personas/snapshots/${persona.id}.ts at ${rev}: not a generated snapshot`);
  const snap = JSON.parse(JSON.parse(m[1]) as string) as PersonaSnapshot;
  const rec: StoredRecording = {
    version: 1,
    personaId: snap.personaId,
    recordedAt: snap.recordedAt,
    qlooMock: snap.qlooMock,
    request: snap.request,
    parts: {
      sametaste: show(`eval/fixtures/${name}.sametaste.ndjson`),
      llm_only: show(`eval/fixtures/${name}.llm_only.ndjson`),
      replans: show(`eval/fixtures/${name}.replans.json`),
    },
  };
  // the fixtures (what /demo served) and the snapshot (what `/` served) must be the same run
  const same = (lines: string, events: unknown[]) => JSON.stringify(lines.split("\n").filter(Boolean).map((l) => JSON.parse(l))) === JSON.stringify(events);
  const replans = JSON.parse(rec.parts.replans) as Record<string, string[]>;
  if (
    !same(rec.parts.sametaste, snap.sametaste) ||
    !same(rec.parts.llm_only, snap.llm_only) ||
    JSON.stringify(Object.keys(replans).sort()) !== JSON.stringify(Object.keys(snap.replans).sort()) ||
    Object.entries(replans).some(([id, ls]) => !same(ls.join("\n"), snap.replans[id]))
  ) {
    throw new Error(`eval/fixtures/${name}.* and the ${persona.id} snapshot at ${rev} are different recordings`);
  }
  return rec;
}

function validate(rec: StoredRecording): number {
  if (rec.qlooMock) throw new Error(`${rec.personaId}: a mock recording (qlooMock: true); only live recordings go to KV`);
  let n = 0;
  const check = (l: string) => {
    AgentEventSchema.parse(JSON.parse(l));
    n++;
  };
  rec.parts.sametaste.split("\n").filter(Boolean).forEach(check);
  rec.parts.llm_only.split("\n").filter(Boolean).forEach(check);
  Object.values(JSON.parse(rec.parts.replans) as Record<string, string[]>).flat().forEach(check);
  const started = JSON.parse(rec.parts.sametaste.split("\n")[0]) as { type: string; qlooMock?: boolean };
  if (started.type !== "run_started" || started.qlooMock !== false) throw new Error(`${rec.personaId}: the run did not start on live Qloo`);
  return n;
}

async function main() {
  const rev = arg("from-git");
  const dir = arg("dir");
  if (!rev === !dir) throw new Error("pass --from-git <sha> or --dir <.recordings/persona-id>");
  const rec = rev ? fromGit(rev, arg("persona") ?? "maya") : readLocalRecording(dir!);
  const events = validate(rec);
  console.log(`${rec.personaId}: recorded ${rec.recordedAt}, ${events} events, live Qloo`);

  if (rev) {
    const local = join(LOCAL_RECORDINGS, rec.personaId);
    writeLocalRecording(local, rec);
    console.log(`  kept a copy in ${local}/ (gitignored)`);
  }

  let kv: KV;
  if (flag("dry-run")) {
    kv = new MemoryKV();
    console.log("  dry run: an in-memory store, nothing uploaded");
  } else {
    if (!url || !token) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN) must be set");
    const upstash = new UpstashKV(url, token);
    if (!(await upstash.probe())) throw new Error("the KV store did not answer PING");
    kv = upstash;
  }
  const w = await writeRecording(kv, rec);
  const back = await readRecording(kv, rec.personaId);
  for (const p of RECORDING_PARTS) if (back?.parts[p] !== rec.parts[p]) throw new Error(`read back: ${p} differs`);
  if (JSON.stringify(back?.request) !== JSON.stringify(rec.request)) throw new Error("read back: request differs");
  console.log(`  ${w.key} rev ${w.rev}:`);
  for (const p of RECORDING_PARTS) console.log(`    ${p.padEnd(10)} ${w.parts[p].bytes} bytes in ${w.parts[p].chunks} chunk${w.parts[p].chunks === 1 ? "" : "s"}`);
  console.log("  read back and compared byte for byte: OK");
}

main().catch((err) => {
  console.error(`upload-recording failed: ${redact(String((err as Error)?.message ?? err))}`);
  process.exit(1);
});
