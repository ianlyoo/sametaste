/**
 * Minimal RFC 4180 CSV reader. Runs in the browser; nothing here touches the network.
 * Handles quoted fields, doubled quotes, CRLF/LF/CR line ends, a UTF-8 BOM and
 * comma, semicolon or tab delimiters (auto-detected from the first lines).
 */

export type Delimiter = "," | ";" | "\t";

export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 4096).split(/\r\n|\n|\r/).slice(0, 10);
  let best: Delimiter = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t"] as const) {
    // Count delimiters outside quotes per line; prefer the one that is frequent and consistent.
    const counts = sample.filter((l) => l.trim()).map((l) => countOutsideQuotes(l, d));
    if (!counts.length) continue;
    const max = Math.max(...counts);
    const consistent = counts.filter((c) => c === max).length;
    const score = max === 0 ? 0 : max * 10 + consistent;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/** Parse CSV text into rows of trimmed cells. Blank lines are dropped. */
export function parseCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === "\r" || ch === "\n") {
      pushRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      cell += ch;
    }
    i++;
  }
  if (cell !== "" || row.length) pushRow();
  return rows;
}
