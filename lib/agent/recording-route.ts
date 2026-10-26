/**
 * GET /api/recording/:persona?part=sametaste|llm_only|replans: a sample
 * persona's recorded run for the /demo replay, byte for byte as recorded.
 * The live recording comes from the server's KV (lib/agent/recordings.ts);
 * with none there, the bundled mock recording, whose run_started says
 * qlooMock so the page shows "Sample Qloo". Without `part`: what is served.
 */
import { PERSONAS } from "../../personas";
import { agentEnv } from "./config";
import { kvFromEnv, type KV } from "./kv";
import { personaRecording, RECORDING_PARTS, type RecordingPart } from "./recordings";

const LIVE_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const MOCK_CACHE = "public, max-age=60, s-maxage=60";

export async function handleRecordingRequest(request: Request, persona: string, deps: { kv?: KV } = {}): Promise<Response> {
  const p = PERSONAS.find((x) => x.id === persona || x.id.split("-")[0] === persona);
  if (!p) return Response.json({ error: "unknown persona" }, { status: 404, headers: { "cache-control": "no-store" } });
  const kv = deps.kv ?? kvFromEnv(agentEnv());
  const r = await personaRecording(kv, p.id);
  if (!r) return Response.json({ error: "no recording" }, { status: 404, headers: { "cache-control": "no-store" } });
  const headers = { "cache-control": r.source === "kv" ? LIVE_CACHE : MOCK_CACHE, "x-recording-source": r.source, "x-content-type-options": "nosniff" };
  const part = new URL(request.url).searchParams.get("part");
  if (part === null) return Response.json({ personaId: r.rec.personaId, recordedAt: r.rec.recordedAt, qlooMock: r.rec.qlooMock, source: r.source, parts: RECORDING_PARTS }, { headers });
  if (!RECORDING_PARTS.includes(part as RecordingPart)) return Response.json({ error: `part is one of ${RECORDING_PARTS.join(", ")}` }, { status: 400, headers: { "cache-control": "no-store" } });
  const type = part === "replans" ? "application/json" : "application/x-ndjson";
  return new Response(r.rec.parts[part as RecordingPart], { status: 200, headers: { ...headers, "content-type": `${type}; charset=utf-8` } });
}
