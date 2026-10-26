/**
 * GET /api/recording/:persona?part=sametaste|llm_only|replans: the recorded
 * run /demo replays (lib/agent/recording-route.ts). Live recordings stay in
 * the server's KV, never in the repository.
 */
import { connection } from "next/server";
import { handleRecordingRequest } from "@/lib/agent/recording-route";

export async function GET(request: Request, ctx: { params: Promise<{ persona: string }> }) {
  await connection();
  const { persona } = await ctx.params;
  return handleRecordingRequest(request, persona);
}
