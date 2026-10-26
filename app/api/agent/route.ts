/**
 * POST /api/agent: streams AgentEvent NDJSON (see lib/contract.ts).
 * GET /api/agent: non-secret status (live model available, Qloo mock, cap).
 */
import { connection } from "next/server";
import { agentStatus, handleAgentRequest } from "@/lib/agent/handler";

export const maxDuration = 60;

export async function POST(request: Request) {
  return handleAgentRequest(request);
}

export async function GET() {
  await connection();
  return Response.json(await agentStatus(), { headers: { "cache-control": "no-store" } });
}
