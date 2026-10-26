/** Fixed-window per-IP rate limit on top of the KV. IPs are hashed. */
import { createHash } from "node:crypto";
import type { KV } from "./kv";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterS: number;
}

export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export async function rateLimit(
  kv: KV,
  ip: string,
  opts: { max: number; windowS: number; now?: number },
): Promise<RateLimitResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowS * 1000;
  const start = Math.floor(now / windowMs) * windowMs;
  const id = createHash("sha256").update(`sametaste:${ip}`).digest("hex").slice(0, 16);
  const n = await kv.incrByFloat(`rl:${id}:${start}`, 1, opts.windowS + 5);
  const retryAfterS = Math.ceil((start + windowMs - now) / 1000);
  return { ok: n <= opts.max, remaining: Math.max(0, opts.max - n), retryAfterS };
}
