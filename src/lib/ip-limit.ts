/**
 * Per-IP fixed-window limiter for the public (token) routes: 60 requests per IP per minute. In memory, so it is per app
 * instance (the app runs as one container); the proxy or gateway in front is the second layer.
 */
const WINDOW_MS = 60_000;
export const PUBLIC_LIMIT_PER_MINUTE = 60;
const MAX_TRACKED_IPS = 10_000;

const hits = new Map<string, { windowStart: number; n: number }>();

/** Returns true when this request is allowed. `now` is a parameter for tests. */
export function allowPublicRequest(ip: string, now: number = Date.now(), limit: number = PUBLIC_LIMIT_PER_MINUTE): boolean {
  if (hits.size >= MAX_TRACKED_IPS) {
    for (const [key, v] of hits) if (now - v.windowStart >= WINDOW_MS) hits.delete(key);
    // Still full of live entries: refuse new addresses rather than grow without bound.
    if (hits.size >= MAX_TRACKED_IPS && !hits.has(ip)) return false;
  }
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    hits.set(ip, { windowStart: now, n: 1 });
    return true;
  }
  entry.n += 1;
  return entry.n <= limit;
}

/**
 * The client address behind the proxy or gateway: the last `X-Forwarded-For` entry is the one it appended; earlier
 * entries are whatever the caller claimed.
 */
export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

/** Same rule for code with no `Request`, such as a page reading `headers()` from `next/headers`. */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").pop()?.trim();
  return last || "unknown";
}

/** For tests. */
export function resetPublicLimiter(): void {
  hits.clear();
}
