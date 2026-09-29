/**
 * Shared in-memory rate limiter (per key). Resets on restart; sufficient for
 * abuse-throttling, not a DDoS control.
 *
 * TODO: move to a Redis/DB-backed store for multi-instance deployments —
 * in-memory buckets neither survive restarts nor coordinate across instances.
 */

const rateBuckets = new Map<string, { n: number; reset: number }>();

export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    rateBuckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n += 1;
  return b.n <= max;
}

// Best-effort client IP from proxy headers, falling back to the socket.
// Note: x-forwarded-for is spoofable — treat IP-keyed limits as
// abuse-throttling, not as a security boundary.
export function clientIpFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string {
  const fwd = headers["x-forwarded-for"] ?? headers["x-real-ip"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof first === "string" && first) return first.split(",")[0].trim();
  return "unknown";
}
