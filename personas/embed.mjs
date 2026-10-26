// Regenerates personas/data.ts from the CSV files: node personas/embed.mjs
import { readFileSync, writeFileSync } from "node:fs";
const ids = ["maya-williamsburg", "dev-flatiron", "sam-eastvillage"];
const dir = new URL(".", import.meta.url);
const lines = [
  "/** Generated from personas/*.csv (embedded so serverless routes need no fs). Run: npm run personas:embed */",
  "export const PERSONA_CSV: Record<string, string> = {",
  ...ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(readFileSync(new URL(`${id}.csv`, dir), "utf8"))},`),
  "};\n",
];
writeFileSync(new URL("data.ts", dir), lines.join("\n"));
