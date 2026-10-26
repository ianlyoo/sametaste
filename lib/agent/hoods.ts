/**
 * Is a place in the neighbourhood the model named? Qloo has no neighbourhood
 * field (geocode stops at city and borough), so this reads the address: its
 * ZIP code against the ZIPs that neighbourhood spans, else the
 * neighbourhood's name in it, else its distance from the neighbourhood's centre.
 * Generous on purpose: a ZIP shared by two neighbourhoods counts for both.
 * NYC only; anywhere else (or "online", "citywide") can't be checked.
 */
import { haversineM } from "../qloo/geo";
import { HOODS } from "../qloo/mock/world";
import { normName } from "./text";

interface HoodArea {
  name: string;
  aliases?: string[];
  lat: number;
  lon: number;
  zips: string[];
}

/** Approximate centres (the mock world's where it has them) and the ZIPs each neighbourhood spans. */
const ZIPS: Record<string, string[]> = {
  Williamsburg: ["11211", "11249", "11206"],
  "East Williamsburg": ["11206", "11211", "11237"],
  Greenpoint: ["11222"],
  Bushwick: ["11206", "11221", "11237"],
  "Park Slope": ["11215", "11217"],
  "Crown Heights": ["11213", "11216", "11225", "11238"],
  "Carroll Gardens": ["11231"],
  "Cobble Hill": ["11201", "11231"],
  Gowanus: ["11215", "11217", "11231"],
  "Boerum Hill": ["11201", "11217"],
  "Brooklyn Heights": ["11201"],
  DUMBO: ["11201"],
  "Fort Greene": ["11205", "11217"],
  "Clinton Hill": ["11205", "11238"],
  "Prospect Heights": ["11238"],
  "Bed-Stuy": ["11205", "11216", "11221", "11233"],
  "Red Hook": ["11231"],
  "East Village": ["10003", "10009"],
  "West Village": ["10014"],
  "Greenwich Village": ["10003", "10011", "10012", "10014"],
  "Lower East Side": ["10002"],
  SoHo: ["10012", "10013"],
  NoHo: ["10003", "10012"],
  Nolita: ["10012"],
  Tribeca: ["10007", "10013"],
  Chinatown: ["10002", "10013"],
  Chelsea: ["10001", "10011"],
  Flatiron: ["10010", "10011"],
  "Union Square": ["10003"],
  Gramercy: ["10003", "10010"],
  "Kips Bay": ["10016"],
  "Murray Hill": ["10016"],
  Midtown: ["10017", "10018", "10019", "10020", "10022", "10036"],
  "Hell's Kitchen": ["10019", "10036"],
  "Financial District": ["10004", "10005", "10006", "10038"],
  "Upper West Side": ["10023", "10024", "10025", "10069"],
  "Upper East Side": ["10021", "10028", "10065", "10075", "10128"],
  Harlem: ["10026", "10027", "10030", "10037", "10039"],
  Astoria: ["11102", "11103", "11105", "11106"],
  "Long Island City": ["11101", "11109"],
};

const CENTRES: Record<string, [number, number]> = {
  "East Williamsburg": [40.7142, -73.9375],
  "Carroll Gardens": [40.6795, -73.9992],
  "Cobble Hill": [40.686, -73.9969],
  Gowanus: [40.6733, -73.9903],
  "Boerum Hill": [40.6848, -73.9847],
  "Brooklyn Heights": [40.696, -73.9937],
  DUMBO: [40.7033, -73.9881],
  "Fort Greene": [40.6892, -73.9748],
  "Clinton Hill": [40.6897, -73.9661],
  "Prospect Heights": [40.6774, -73.9668],
  "Bed-Stuy": [40.6872, -73.9418],
  "Red Hook": [40.6734, -74.0083],
  "Greenwich Village": [40.7336, -74.0027],
  NoHo: [40.7289, -73.9925],
  Nolita: [40.723, -73.9949],
  Tribeca: [40.7163, -74.0086],
  Chinatown: [40.7158, -73.997],
  "Union Square": [40.7359, -73.9911],
  Gramercy: [40.7368, -73.9845],
  "Kips Bay": [40.7423, -73.9801],
  "Murray Hill": [40.7479, -73.9757],
  "Hell's Kitchen": [40.7638, -73.9918],
};

const ALIASES: Record<string, string[]> = {
  "Bed-Stuy": ["Bedford-Stuyvesant", "Bedford Stuyvesant"],
  "Lower East Side": ["LES"],
  "Financial District": ["FiDi"],
  "Long Island City": ["LIC"],
  "Hell's Kitchen": ["Clinton"],
  Gramercy: ["Gramercy Park"],
  "Greenwich Village": ["The Village"],
  Williamsburg: ["South Williamsburg", "North Williamsburg"],
};

const AREAS: HoodArea[] = Object.entries(ZIPS).map(([name, zips]) => {
  const own = HOODS.find((h) => h.name === name);
  const [lat, lon] = own ? [own.lat, own.lon] : CENTRES[name];
  return { name, aliases: ALIASES[name], lat, lon, zips };
});

/** Within this of a neighbourhood's centre counts as in it, when the address has no ZIP. */
const HOOD_RADIUS_M = 1500;

/** The neighbourhood a free-text answer names ("Williamsburg, Brooklyn" -> Williamsburg); undefined when unknown. */
export function findHood(claimed: string | undefined): HoodArea | undefined {
  const c = normName(claimed ?? "");
  if (!c) return undefined;
  const names = (a: HoodArea) => [a.name, ...(a.aliases ?? [])].map(normName);
  // exact first, then the longest name the answer contains ("East Williamsburg" before "Williamsburg")
  return (
    AREAS.find((a) => names(a).includes(c)) ??
    AREAS.flatMap((a) => names(a).map((n) => ({ a, n })))
      .filter(({ n }) => n.length >= 4 && ` ${c} `.includes(` ${n} `))
      .sort((x, y) => y.n.length - x.n.length)[0]?.a
  );
}

/** "... Brooklyn, NY 11231" -> "11231". */
export function zipOf(address: string | undefined): string | undefined {
  return /\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\s*$/.exec(address ?? "")?.[1];
}

/** True / false when it can be told; undefined for an unknown neighbourhood or a place with no address or coordinates. */
export function inClaimedHood(claimed: string | undefined, place: { address?: string; lat?: number; lon?: number }): boolean | undefined {
  const area = findHood(claimed);
  if (!area) return undefined;
  // the ZIP first: a street can carry a neighbourhood's name ("Greenpoint Ave" runs through Sunnyside)
  const zip = zipOf(place.address);
  if (zip) return area.zips.includes(zip);
  const addr = normName(place.address ?? "");
  if (addr && [area.name, ...(area.aliases ?? [])].some((n) => ` ${addr} `.includes(` ${normName(n)} `))) return true;
  if (place.lat !== undefined && place.lon !== undefined) return haversineM(area.lat, area.lon, place.lat, place.lon) <= HOOD_RADIUS_M;
  return undefined;
}
