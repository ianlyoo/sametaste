/**
 * The live persona recordings, kept out of git. Qloo's terms allow private
 * server-side caching of its responses but not Qloo data in a public
 * repository, so a recording made on live Qloo lives only in the server's KV
 * (Upstash in production) and a gitignored local copy (.recordings/). The
 * repository bundles mock recordings only (personas/snapshots, qlooMock
 * true); they are the fallback whenever the store has nothing.
 *
 * KV layout (v1), values well under Upstash's request limits:
 *   rec:v1:<personaId>                      manifest: who, when, request, rev, parts
 *   rec:v1:<personaId>:<rev>:<part>:<i>     chunk i of a part's text
 * Parts are the recording's files byte for byte: `sametaste` and `llm_only`
 * (NDJSON) and `replans` (JSON, re-plan lines keyed by the rejected swap id).
 * Chunks are written before the manifest and carry its rev, so a reader
 * never mixes two recordings.
 */
import { createHash } from "node:crypto";
import { AgentEventSchema, type AgentEvent, type Location, type MerchantAggregate } from "../contract";
import { SNAPSHOTS, type PersonaSnapshot } from "../../personas/snapshots";
import type { KV } from "./kv";

export const RECORDING_PARTS = ["sametaste", "llm_only", "replans"] as const;
export type RecordingPart = (typeof RECORDING_PARTS)[number];

/** A recording as files: the NDJSON and JSON texts the replay serves, plus what the `/` fallback matches on. */
export interface StoredRecording {
  version: 1;
  personaId: string;
  recordedAt: string;
  qlooMock: boolean;
  request: { location: Location; merchants: MerchantAggregate[] };
  parts: Record<RecordingPart, string>;
}

interface Manifest {
  version: 1;
  personaId: string;
  recordedAt: string;
  qlooMock: boolean;
  request: StoredRecording["request"];
  rev: string;
  parts: Record<RecordingPart, { chunks: number; bytes: number; sha256: string }>;
}

/** Characters per chunk: a quarter of a megabyte, with room for JSON escaping. */
export const CHUNK_CHARS = 256 * 1024;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const recordingKey = (personaId: string) => `rec:v1:${personaId}`;
const chunkKey = (personaId: string, rev: string, part: RecordingPart, i: number) => `${recordingKey(personaId)}:${rev}:${part}:${i}`;

export function ndjson(events: AgentEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join("");
}
const lines = (text: string) => text.split("\n").filter(Boolean);

/** A bundled (or any) snapshot as recording files. */
export function fromSnapshot(snap: PersonaSnapshot): StoredRecording {
  const replans = Object.fromEntries(Object.entries(snap.replans).map(([id, evs]) => [id, evs.map((e) => JSON.stringify(e))]));
  return {
    version: 1,
    personaId: snap.personaId,
    recordedAt: snap.recordedAt,
    qlooMock: snap.qlooMock,
    request: snap.request,
    parts: { sametaste: ndjson(snap.sametaste), llm_only: ndjson(snap.llm_only), replans: JSON.stringify(replans) },
  };
}

/** The recording as the handler replays it (each event validated). */
export function toSnapshot(rec: StoredRecording): PersonaSnapshot {
  const events = (text: string) => lines(text).map((l) => AgentEventSchema.parse(JSON.parse(l)) as AgentEvent);
  const replans = JSON.parse(rec.parts.replans) as Record<string, string[]>;
  return {
    version: 1,
    personaId: rec.personaId,
    recordedAt: rec.recordedAt,
    qlooMock: rec.qlooMock,
    request: rec.request,
    sametaste: events(rec.parts.sametaste),
    llm_only: events(rec.parts.llm_only),
    replans: Object.fromEntries(Object.entries(replans).map(([id, ls]) => [id, ls.map((l) => AgentEventSchema.parse(JSON.parse(l)) as AgentEvent)])),
  };
}

/** Writes a recording: chunks first, the manifest last. Returns the keys written. */
export async function writeRecording(kv: KV, rec: StoredRecording): Promise<{ key: string; rev: string; parts: Manifest["parts"] }> {
  const rev = sha256(RECORDING_PARTS.map((p) => rec.parts[p]).join("\u0000")).slice(0, 12);
  const parts = {} as Manifest["parts"];
  for (const part of RECORDING_PARTS) {
    const text = rec.parts[part];
    const n = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
    for (let i = 0; i < n; i++) await kv.set(chunkKey(rec.personaId, rev, part, i), text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
    parts[part] = { chunks: n, bytes: Buffer.byteLength(text), sha256: sha256(text) };
  }
  const manifest: Manifest = { version: 1, personaId: rec.personaId, recordedAt: rec.recordedAt, qlooMock: rec.qlooMock, request: rec.request, rev, parts };
  await kv.set(recordingKey(rec.personaId), manifest);
  return { key: recordingKey(rec.personaId), rev, parts };
}

/** Reads a recording back from KV; undefined when there is none or a part does not check out. */
export async function readRecording(kv: KV, personaId: string): Promise<StoredRecording | undefined> {
  const m = await kv.get<Manifest>(recordingKey(personaId));
  if (!m || m.version !== 1 || !m.parts) return undefined;
  const texts = await Promise.all(
    RECORDING_PARTS.map(async (part) => {
      const p = m.parts[part];
      if (!p) return undefined;
      const chunks = await Promise.all(Array.from({ length: p.chunks }, (_, i) => kv.get<string>(chunkKey(personaId, m.rev, part, i))));
      if (chunks.some((c) => typeof c !== "string")) return undefined;
      const text = chunks.join("");
      return sha256(text) === p.sha256 ? text : undefined;
    }),
  );
  if (texts.some((t) => t === undefined)) return undefined;
  return {
    version: 1,
    personaId: m.personaId,
    recordedAt: m.recordedAt,
    qlooMock: m.qlooMock,
    request: m.request,
    parts: Object.fromEntries(RECORDING_PARTS.map((p, i) => [p, texts[i]!])) as StoredRecording["parts"],
  };
}

const HIT_MS = 5 * 60_000;
const MISS_MS = 60_000;
const memo = new Map<string, { at: number; rec: StoredRecording | undefined; snap?: PersonaSnapshot }>();

/** The live recording from KV, memoised per server instance (a hit for 5 min, a miss for 1 min); undefined on any error. */
export async function liveRecording(kv: KV, personaId: string): Promise<{ rec: StoredRecording; snap: PersonaSnapshot } | undefined> {
  const hit = memo.get(personaId);
  if (hit && Date.now() - hit.at < (hit.rec ? HIT_MS : MISS_MS)) return hit.rec && hit.snap ? { rec: hit.rec, snap: hit.snap } : undefined;
  let rec: StoredRecording | undefined;
  let snap: PersonaSnapshot | undefined;
  try {
    rec = await readRecording(kv, personaId);
    snap = rec ? toSnapshot(rec) : undefined;
  } catch {
    rec = undefined; // unreachable store or a bad value: the bundled mock serves
  }
  memo.set(personaId, { at: Date.now(), rec: snap ? rec : undefined, snap });
  return rec && snap ? { rec, snap } : undefined;
}

/** Test hook. */
export function clearRecordingMemo(): void {
  memo.clear();
}

/** What a sample persona replays: the live recording from KV, else the bundled mock one. */
export async function personaRecording(
  kv: KV,
  personaId: string,
): Promise<{ source: "kv" | "bundled"; rec: StoredRecording; snap: PersonaSnapshot } | undefined> {
  const live = await liveRecording(kv, personaId);
  if (live) return { source: "kv", ...live };
  const snap = SNAPSHOTS[personaId];
  return snap ? { source: "bundled", rec: fromSnapshot(snap), snap } : undefined;
}
