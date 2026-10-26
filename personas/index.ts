/**
 * Three synthetic NYC personas (invented transactions; merchant names are
 * public businesses). CSV columns: date,description,amount,currency;
 * positive amount = spend.
 */
import type { Location, MerchantAggregate, Transaction } from "../lib/contract";

export interface Persona {
  id: string;
  name: string;
  blurb: string;
  file: string;
  location: Location;
}

export const PERSONAS: Persona[] = [
  {
    id: "maya-williamsburg",
    name: "Maya",
    blurb: "29, product designer in Williamsburg. Pour-over every morning, natural wine on Fridays.",
    file: "maya-williamsburg.csv",
    location: { label: "Williamsburg, Brooklyn, NY", lat: 40.7081, lon: -73.9571, radiusM: 2500 },
  },
  {
    id: "dev-flatiron",
    name: "Dev",
    blurb: "33, analyst near Flatiron. Desk salads, cycling classes, client dinners.",
    file: "dev-flatiron.csv",
    location: { label: "Flatiron, Manhattan, NY", lat: 40.7411, lon: -73.9897, radiusM: 2500 },
  },
  {
    id: "sam-eastvillage",
    name: "Sam",
    blurb: "25, grad student in the East Village. Cheap eats, dive bars, the odd splurge.",
    file: "sam-eastvillage.csv",
    location: { label: "East Village, Manhattan, NY", lat: 40.7265, lon: -73.9815, radiusM: 2000 },
  },
];

/** Minimal CSV parser for the persona format (quoted fields supported). */
export function parseCsv(text: string): Transaction[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(rows[0]).map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  return rows.slice(1).map((line, i) => {
    const c = split(line);
    return {
      id: `t${i + 1}`,
      date: c[idx("date")],
      rawMerchant: c[idx("description")],
      amount: Number(c[idx("amount")]),
      currency: idx("currency") >= 0 ? c[idx("currency")] || "USD" : "USD",
    };
  });
}

/** Stable merchant key: descriptor without digits, '#', '*'. */
export function merchantKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[0-9#*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function aggregateTransactions(txns: Transaction[]): MerchantAggregate[] {
  const by = new Map<string, MerchantAggregate>();
  const dates = txns.map((t) => t.date).sort();
  const windowDays = dates.length
    ? Math.max(1, Math.round((Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000) + 1)
    : 30;
  for (const t of txns) {
    if (!(t.amount > 0)) continue;
    const key = merchantKey(t.rawMerchant);
    const cur = by.get(key) ?? { key, rawMerchant: t.rawMerchant, count: 0, totalSpend: 0, currency: t.currency, windowDays: Math.max(28, windowDays) };
    cur.count++;
    cur.totalSpend = Math.round((cur.totalSpend + t.amount) * 100) / 100;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.totalSpend - a.totalSpend);
}

import { PERSONA_CSV } from "./data";

/** Persona with its CSV and the aggregated merchants, ready for an agent request. */
export function loadPersona(id: string) {
  const p = PERSONAS.find((x) => x.id === id);
  const csv = PERSONA_CSV[id];
  if (!p || !csv) return undefined;
  return { ...p, csv, merchants: aggregateTransactions(parseCsv(csv)) };
}
