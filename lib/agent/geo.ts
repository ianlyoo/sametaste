import type { Location } from "../contract";
import { HOODS } from "../qloo/mock/world";
import { normName } from "./text";

export const NYC_CENTER = { lat: 40.7308, lon: -73.9973 };
export const DEFAULT_RADIUS_M = 2500;

/**
 * Coordinates for a location: explicit lat/lon, else a known NYC
 * neighbourhood in the label, else Manhattan's centre.
 */
export function resolveLocation(loc: Location): { lat: number; lon: number; radiusM: number; approximate: boolean } {
  const radiusM = loc.radiusM ?? DEFAULT_RADIUS_M;
  if (loc.lat !== undefined && loc.lon !== undefined) return { lat: loc.lat, lon: loc.lon, radiusM, approximate: false };
  const label = normName(loc.label);
  const hood = HOODS.find((h) => label.includes(normName(h.name)));
  if (hood) return { lat: hood.lat, lon: hood.lon, radiusM, approximate: true };
  return { ...NYC_CENTER, radiusM: Math.max(radiusM, 5000), approximate: true };
}
