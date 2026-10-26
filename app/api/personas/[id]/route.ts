/**
 * GET /api/personas/:id: persona metadata, its CSV and aggregated merchants.
 */
import { PERSONAS, loadPersona } from "@/personas";

export function generateStaticParams() {
  return PERSONAS.map((p) => ({ id: p.id }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadPersona(id);
  if (!p) return Response.json({ error: "unknown persona" }, { status: 404 });
  const { file: _file, ...rest } = p;
  return Response.json(rest);
}
