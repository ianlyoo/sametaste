import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventSchema, type AgentEvent } from "../contract";
import { loadPersona } from "../../personas";
import { SNAPSHOTS } from "../../personas/snapshots";
import { QlooClient, type QlooClientOptions } from "../qloo/client";
import { agentEnv } from "./config";
import { handleAgentRequest } from "./handler";
import { MemoryKV, type KV } from "./kv";
import { handleRecordingRequest } from "./recording-route";
import { CHUNK_CHARS, clearRecordingMemo, fromSnapshot, readRecording, recordingKey, writeRecording, type StoredRecording } from "./recordings";

vi.setConfig({ testTimeout: 20_000 });

const maya = loadPersona("maya-williamsburg")!;
const bundled = SNAPSHOTS["maya-williamsburg"];

/** The bundled mock run dressed up as a live one (in memory only), so the KV path is told apart from the fallback. */
function fakeLive(): StoredRecording {
  const rec = fromSnapshot(bundled);
  const live = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const e = JSON.parse(l) as AgentEvent;
        return JSON.stringify(e.type === "run_started" ? { ...e, qlooMock: !e.qlooMock } : e);
      })
      .map((l) => `${l}\n`)
      .join("");
  return { ...rec, qlooMock: false, recordedAt: "2026-10-23T04:48:41.535Z", parts: { ...rec.parts, sametaste: live(rec.parts.sametaste), llm_only: live(rec.parts.llm_only) } };
}

const get = (persona: string, part?: string, kv: KV = new MemoryKV()) =>
  handleRecordingRequest(new Request(`http://local/api/recording/${persona}${part ? `?part=${part}` : ""}`), persona, { kv });

beforeEach(() => clearRecordingMemo());

describe("live recordings in the server's KV (rec:v1)", () => {
  it("writes chunks then the manifest, and reads the files back byte for byte", async () => {
    const kv = new MemoryKV();
    const rec = fakeLive();
    const w = await writeRecording(kv, rec);
    expect(w.key).toBe(recordingKey("maya-williamsburg"));
    expect(w.parts.replans.chunks).toBe(Math.ceil(rec.parts.replans.length / CHUNK_CHARS));
    expect(w.parts.replans.chunks).toBeGreaterThan(1);
    expect(await readRecording(kv, "maya-williamsburg")).toEqual(rec);
    expect(await readRecording(kv, "dev-flatiron")).toBeUndefined();
  });

  it("a damaged chunk is no recording (the mock serves instead)", async () => {
    const kv = new MemoryKV();
    const w = await writeRecording(kv, fakeLive());
    await kv.set(`${w.key}:${w.rev}:replans:1`, "tampered");
    expect(await readRecording(kv, "maya-williamsburg")).toBeUndefined();
    const res = await get("maya", "replans", kv);
    expect(res.headers.get("x-recording-source")).toBe("bundled");
  });

  it("the bundled mock recording is the tracked fixtures, byte for byte", () => {
    const rec = fromSnapshot(bundled);
    expect(rec.qlooMock).toBe(true);
    expect(rec.parts.sametaste).toBe(readFileSync("eval/fixtures/maya.sametaste.ndjson", "utf8"));
    expect(rec.parts.llm_only).toBe(readFileSync("eval/fixtures/maya.llm_only.ndjson", "utf8"));
    expect(JSON.parse(rec.parts.replans)).toEqual(JSON.parse(readFileSync("eval/fixtures/maya.replans.json", "utf8")));
  });
});

describe("GET /api/recording/:persona", () => {
  it("serves the KV recording with a long cache, else the bundled mock one with a short cache", async () => {
    const empty = await get("maya", "sametaste");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("x-recording-source")).toBe("bundled");
    expect(empty.headers.get("cache-control")).toContain("max-age=60");
    const first = AgentEventSchema.parse(JSON.parse((await empty.text()).split("\n")[0]));
    expect(first.type === "run_started" && first.qlooMock).toBe(true); // the page says "Sample Qloo"

    clearRecordingMemo();
    const kv = new MemoryKV();
    const rec = fakeLive();
    await writeRecording(kv, rec);
    for (const part of ["sametaste", "llm_only", "replans"] as const) {
      const res = await get("maya-williamsburg", part, kv);
      expect(res.headers.get("x-recording-source")).toBe("kv");
      expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
      expect(await res.text()).toBe(rec.parts[part]);
    }
    expect(await (await get("maya", undefined, kv)).json()).toMatchObject({ personaId: "maya-williamsburg", qlooMock: false, source: "kv" });
  });

  it("an unreachable store falls back to the mock recording", async () => {
    const down: KV = { persistent: true, get: async () => { throw new Error("down"); }, set: async () => {}, incrByFloat: async () => 0 };
    const res = await get("maya", "llm_only", down);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-recording-source")).toBe("bundled");
  });

  it("refuses unknown personas and parts", async () => {
    expect((await get("nobody", "sametaste")).status).toBe(404);
    expect((await get("maya", "secrets")).status).toBe(400);
  });
});

describe("the `/` fallback replays the KV recording", () => {
  it("a sample persona gets the live recording when KV has one, the bundled mock one when not", async () => {
    const env = agentEnv({ NODE_ENV: "production" });
    const qloo = (budget: QlooClientOptions["budget"]) => new QlooClient({ mock: true, budget });
    const post = () => new Request("http://local/api/agent", { method: "POST", body: JSON.stringify({ personaId: maya.id, location: maya.location, merchants: maya.merchants }), headers: { "x-forwarded-for": "203.0.113.50" } });
    const startOf = async (kv: KV) => AgentEventSchema.parse(JSON.parse((await (await handleAgentRequest(post(), { env, kv, qloo })).text()).split("\n")[0]));

    const mock = await startOf(new MemoryKV());
    expect(mock.type === "run_started" && mock.qlooMock).toBe(true);

    clearRecordingMemo();
    const kv = new MemoryKV();
    await writeRecording(kv, fakeLive());
    const live = await startOf(kv);
    expect(live.type === "run_started" && live.qlooMock).toBe(false);
    expect(live.type === "run_started" && live.fromCache).toBe(true);
  });
});
