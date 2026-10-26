/** GET /api/personas: the three synthetic NYC personas (metadata only). */
import { PERSONAS } from "@/personas";

export async function GET() {
  return Response.json({ personas: PERSONAS.map(({ file: _file, ...p }) => p) });
}
