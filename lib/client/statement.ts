/**
 * Card / bank statement CSV -> transactions, entirely in the browser.
 *
 * Known exports are matched by header; anything with a date, a description and
 * an amount (or debit/credit) column falls back to the generic reader, which
 * also covers the SameTaste persona CSVs (`date,merchant,amount[,category]`).
 * Wells Fargo exports have no header and are detected by shape.
 *
 * Output amounts are normalised so that spend is positive and refunds negative.
 * Payments to the card, transfers, P2P, payroll, ATM and fee rows are dropped
 * here and never leave the browser (P2P descriptors often carry people's names).
 */
import type { Transaction } from "../contract";
import { parseCsv } from "./csv";

export type StatementFormatId =
  | "chase_card"
  | "chase_checking"
  | "amex"
  | "capital_one"
  | "citi"
  | "discover"
  | "apple_card"
  | "boa_card"
  | "boa_checking"
  | "wells_fargo"
  | "generic";

export interface ParsedStatement {
  format: StatementFormatId;
  formatLabel: string;
  /** Spend positive, refunds negative. Sorted by date. */
  transactions: Transaction[];
  /** Raw bank category per transaction id, when the export has one. */
  bankCategories: Record<string, string>;
  skipped: { nonSpend: number; invalid: number };
  /** Inclusive ISO date range of kept transactions. */
  range: { from: string; to: string };
  /** Days covered, inclusive, 1..366. */
  windowDays: number;
}

export type StatementErrorCode = "empty" | "too_large" | "no_header" | "no_rows";

export class StatementParseError extends Error {
  constructor(
    public code: StatementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StatementParseError";
  }
}

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 20_000;

type Sign = 1 | -1 | "infer";

interface Columns {
  date: number;
  desc: number;
  amount?: number;
  debit?: number;
  credit?: number;
  category?: number;
  type?: number;
}

interface FormatDef {
  id: StatementFormatId;
  label: string;
  /** All of these header names must be present (lower-case). */
  requires: string[];
  /** Any one of these must be present, if given. */
  anyOf?: string[];
  /** Header name overrides; the generic lookup fills the rest. */
  pick?: Partial<Record<keyof Columns, string>>;
  /** Sign of a purchase in the amount column. Ignored for debit/credit exports. */
  sign: Sign;
}

const FORMATS: FormatDef[] = [
  {
    id: "apple_card",
    label: "Apple Card",
    requires: ["transaction date", "clearing date", "merchant", "amount (usd)"],
    pick: { desc: "merchant" },
    sign: 1,
  },
  {
    id: "chase_card",
    label: "Chase credit card",
    requires: ["transaction date", "post date", "description", "category", "type", "amount"],
    sign: -1,
  },
  {
    id: "chase_checking",
    label: "Chase checking",
    requires: ["details", "posting date", "description", "amount", "type"],
    pick: { type: "type" },
    sign: -1,
  },
  {
    id: "capital_one",
    label: "Capital One",
    requires: ["transaction date", "posted date", "card no.", "description", "debit", "credit"],
    sign: 1,
  },
  {
    id: "citi",
    label: "Citi",
    requires: ["status", "date", "description", "debit", "credit"],
    sign: 1,
  },
  {
    id: "discover",
    label: "Discover",
    requires: ["trans. date", "post date", "description", "amount"],
    sign: 1,
  },
  {
    id: "boa_card",
    label: "Bank of America credit card",
    requires: ["posted date", "reference number", "payee", "amount"],
    sign: -1,
  },
  {
    id: "boa_checking",
    label: "Bank of America checking",
    requires: ["date", "description", "amount", "running bal."],
    sign: -1,
  },
  {
    id: "amex",
    label: "American Express",
    requires: ["date", "description", "amount"],
    anyOf: ["extended details", "appears on your statement as", "card member", "account #"],
    sign: 1,
  },
];

const DATE_HEADERS = ["transaction date", "trans. date", "trans date", "date", "posted date", "posting date", "post date"];
const DESC_HEADERS = ["description", "merchant", "merchant name", "payee", "name", "original description"];
const AMOUNT_HEADERS = ["amount", "amount (usd)", "transaction amount"];
const DEBIT_HEADERS = ["debit", "withdrawal", "withdrawals", "debit amount"];
const CREDIT_HEADERS = ["credit", "deposit", "deposits", "credit amount"];
const CATEGORY_HEADERS = ["category"];
const TYPE_HEADERS = ["type", "transaction type"];

const find = (header: string[], names: string[]) => {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return undefined;
};

function columnsFor(header: string[], def?: FormatDef): Columns | null {
  const by = (k: keyof Columns, names: string[]) => {
    const forced = def?.pick?.[k];
    return forced !== undefined ? find(header, [forced]) : find(header, names);
  };
  const date = by("date", DATE_HEADERS);
  const desc = by("desc", DESC_HEADERS);
  const amount = by("amount", AMOUNT_HEADERS);
  const debit = by("debit", DEBIT_HEADERS);
  const credit = by("credit", CREDIT_HEADERS);
  if (date === undefined || desc === undefined) return null;
  if (amount === undefined && debit === undefined) return null;
  return {
    date,
    desc,
    amount,
    debit,
    credit,
    category: by("category", CATEGORY_HEADERS),
    type: by("type", TYPE_HEADERS),
  };
}

const NON_SPEND =
  /\b(PAYMENT THANK YOU|PAYMENT - THANK YOU|THANK YOU FOR YOUR PAYMENT|AUTOPAY|AUTO PAY|AUTOMATIC PAYMENT|ONLINE PAYMENT|MOBILE PAYMENT|CREDIT CARD PAYMENT|EPAYMENT|ZELLE|VENMO|CASH APP|SQUARE CASH|PAYPAL TRANSFER|TRANSFER|XFER|PAYROLL|DIRECT DEP|DIRECT DEPOSIT|ATM|CASH WITHDRAWAL|INTEREST CHARGE|INTEREST PAID|LATE FEE|ANNUAL FEE|OVERDRAFT|FOREIGN TRANSACTION FEE)\b/i;
const NON_SPEND_TYPES =
  /^(payment|transfer|adjustment|interest|fee|deposit|credit card payment|acct_xfer|ach_credit|quickpay_debit|quickpay_credit|loan_pmt|atm|check_deposit|misc_credit)$/i;

/** True for rows that are not a purchase from a merchant. */
export function isNonSpend(description: string, type?: string): boolean {
  if (type && NON_SPEND_TYPES.test(type.trim())) return true;
  return NON_SPEND.test(description);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** US-style dates: MM/DD/YYYY, M/D/YY, YYYY-MM-DD, "Oct 3, 2026", "3 Oct 2026". */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t);
  if (m) return iso(+m[3], +m[1], +m[2]);
  const mon = (w: string) => MONTHS[w.toLowerCase().slice(0, 3)];
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(t);
  if (m && mon(m[1])) return iso(+m[3], mon(m[1]), +m[2]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2}|\d{4})$/.exec(t);
  if (m && mon(m[2])) return iso(+m[3], mon(m[2]), +m[1]);
  return null;
}

/** "$1,234.56", "(12.34)", "-12.34", "12.34 CR", "+3" -> number; null if not a number. */
export function parseAmount(s: string): number | null {
  let t = s.trim().replace(/\s+/g, "");
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (/(CR|-)$/i.test(t) && !/^-/.test(t)) {
    neg = !neg;
    t = t.replace(/(CR|-)$/i, "");
  }
  t = t.replace(/^(USD|US\$|\$)/i, "").replace(/(USD)$/i, "");
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.startsWith("+")) {
    t = t.slice(1);
  }
  t = t.replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const v = Number(t);
  return neg ? -v : v;
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

function detectHeader(rows: string[][]): { index: number; header: string[]; def?: FormatDef; cols: Columns } | null {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const header = rows[i].map(norm);
    for (const def of FORMATS) {
      if (!def.requires.every((h) => header.includes(h))) continue;
      if (def.anyOf && !def.anyOf.some((h) => header.includes(h))) continue;
      const cols = columnsFor(header, def);
      if (cols) return { index: i, header, def, cols };
    }
    const cols = columnsFor(header);
    if (cols) return { index: i, header, cols };
  }
  return null;
}

/** Wells Fargo: no header, `"date","amount","*","","description"`. */
function looksLikeWellsFargo(rows: string[][]): boolean {
  const sample = rows.slice(0, 5);
  return (
    sample.length > 0 &&
    sample.every((r) => r.length >= 5 && parseDate(r[0]) !== null && parseAmount(r[1]) !== null && r[4] !== "")
  );
}

interface RawRow {
  date: string;
  desc: string;
  /** Signed as in the file. */
  amount: number;
  /** For debit/credit exports: already spend-positive. */
  spendPositive: boolean;
  category?: string;
  type?: string;
}

export function parseStatement(text: string): ParsedStatement {
  if (!text || !text.trim()) throw new StatementParseError("empty", "The file is empty.");
  if (text.length > MAX_STATEMENT_BYTES)
    throw new StatementParseError("too_large", "The file is larger than 5 MB. Export a single month instead.");

  const rows = parseCsv(text);
  if (rows.length > MAX_STATEMENT_ROWS + 20)
    throw new StatementParseError("too_large", `More than ${MAX_STATEMENT_ROWS} rows. Export a single month instead.`);

  let format: StatementFormatId = "generic";
  let formatLabel = "CSV";
  let sign: Sign = "infer";
  const raw: RawRow[] = [];
  let invalid = 0;

  const cell = (r: string[], i?: number) => (i === undefined ? "" : (r[i] ?? ""));

  if (looksLikeWellsFargo(rows)) {
    format = "wells_fargo";
    formatLabel = "Wells Fargo";
    sign = -1;
    for (const r of rows) {
      const date = parseDate(r[0]);
      const amount = parseAmount(r[1]);
      if (!date || amount === null || !r[4]) {
        invalid++;
        continue;
      }
      raw.push({ date, desc: r[4], amount, spendPositive: false });
    }
  } else {
    const h = detectHeader(rows);
    if (!h)
      throw new StatementParseError(
        "no_header",
        "Couldn't find date, description and amount columns. Export transactions as CSV from your bank, or use date,merchant,amount.",
      );
    if (h.def) {
      format = h.def.id;
      formatLabel = h.def.label;
      sign = h.def.sign;
    }
    const c = h.cols;
    for (const r of rows.slice(h.index + 1)) {
      const date = parseDate(cell(r, c.date));
      const desc = cell(r, c.desc);
      let amount: number | null;
      let spendPositive = false;
      if (c.amount !== undefined && cell(r, c.amount) !== "") {
        amount = parseAmount(cell(r, c.amount));
      } else {
        const d = parseAmount(cell(r, c.debit));
        const cr = parseAmount(cell(r, c.credit));
        amount = d !== null && d !== 0 ? Math.abs(d) : cr !== null ? -Math.abs(cr) : null;
        spendPositive = true;
      }
      if (!date || !desc || amount === null) {
        invalid++;
        continue;
      }
      raw.push({ date, desc, amount, spendPositive, category: cell(r, c.category) || undefined, type: cell(r, c.type) || undefined });
    }
  }

  let nonSpend = 0;
  const kept = raw.filter((r) => {
    if (isNonSpend(r.desc, r.type)) {
      nonSpend++;
      return false;
    }
    return r.amount !== 0;
  });

  if (sign === "infer") {
    const signed = kept.filter((r) => !r.spendPositive);
    const neg = signed.filter((r) => r.amount < 0).length;
    sign = neg > signed.length - neg ? -1 : 1;
  }

  const transactions: Transaction[] = [];
  const bankCategories: Record<string, string> = {};
  kept
    .map((r) => ({ ...r, spend: r.spendPositive ? r.amount : r.amount * (sign as number) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((r, i) => {
      const id = `t${i}`;
      transactions.push({ id, date: r.date, rawMerchant: r.desc, amount: Math.round(r.spend * 100) / 100, currency: "USD" });
      if (r.category) bankCategories[id] = r.category;
    });

  if (!transactions.some((t) => t.amount > 0))
    throw new StatementParseError("no_rows", "No purchases found in this file.");

  const from = transactions[0].date;
  const to = transactions[transactions.length - 1].date;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

  return {
    format,
    formatLabel,
    transactions,
    bankCategories,
    skipped: { nonSpend, invalid },
    range: { from, to },
    windowDays: Math.min(366, Math.max(1, days)),
  };
}
