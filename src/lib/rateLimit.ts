// In-memory per-IP rate limiter for form submissions.
//
// Counts the POSTs (i.e. Astro action calls — onboarding / status) per source
// IP inside a sliding window and rejects once the cap is hit. This caps the
// blast radius of abuse of the email-sending endpoints (email bombing, Resend
// quota burn, deliverability damage) and any residual bot spam.
//
// Single-instance only — like resultStore, the counts live in process memory,
// so they don't survive a restart and aren't shared across containers. Fine for
// a single-instance Docker deploy; switch to Redis if you scale horizontally.

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HITS = 2; // submissions per IP per window

const hits = new Map<string, number[]>();

function sweep(ip: string, now: number): number[] {
  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.set(ip, recent);
  return recent;
}

/**
 * Record a hit for `ip` and report whether it's allowed. Mutates state: pushes
 * the current timestamp when allowed. Returns `retryAfterMs` (ms until the
 * oldest hit falls out of the window) when blocked, for a Retry-After header.
 */
export function rateLimitCheck(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const recent = sweep(ip, now);
  if (recent.length >= MAX_HITS) {
    const retryAfterMs = recent[0] + WINDOW_MS - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
  }
  recent.push(now);
  return { allowed: true, retryAfterMs: 0 };
}
