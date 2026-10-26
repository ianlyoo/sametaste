/** Great-circle distance in metres. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parses "lat,lon" or WKT "POINT(lon lat)". */
export function parsePoint(s: string): { lat: number; lon: number } | null {
  const wkt = /^\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(s);
  if (wkt) return { lon: Number(wkt[1]), lat: Number(wkt[2]) };
  const pair = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(s);
  if (pair) return { lat: Number(pair[1]), lon: Number(pair[2]) };
  return null;
}
