/**
 * Sample personas for the presets. The CSVs are synthetic (see personas/README.md)
 * and bundled, so presets work offline. For these the request carries the
 * server's own merchant aggregation, which lets the server answer from its
 * bundled snapshot without a model call.
 */
import { loadPersona, PERSONAS } from "../../personas";
import type { Location, MerchantAggregate } from "../contract";

export interface PersonaPreset {
  id: string;
  name: string;
  blurb: string;
  location: Location;
  /** Short place label, e.g. "Williamsburg". */
  place: string;
}

export const PERSONA_PRESETS: PersonaPreset[] = PERSONAS.map((p) => ({
  id: p.id,
  name: p.name,
  blurb: p.blurb,
  location: p.location,
  place: p.location.label.split(",")[0].trim(),
}));

export function personaPayload(id: string): { csv: string; location: Location; merchants: MerchantAggregate[] } | undefined {
  const p = loadPersona(id);
  return p && { csv: p.csv, location: p.location, merchants: p.merchants };
}
