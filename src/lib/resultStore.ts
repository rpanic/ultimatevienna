import type { MembershipInfo } from './membership';

// Short-lived, in-memory store that hands a membership summary from the
// onboarding action to the post-registration result page.
//
// The onboarding action computes the MembershipInfo and stashes it under an
// opaque token; the browser is redirected to /join/<team>/done?t=<token>, and
// the result page reads it back by token. This keeps personal data out of the
// URL and lets the page render the same Astro component the email uses.
//
// Caveat: in-memory, so it does not survive a server restart and is not shared
// across instances. Fine for a single-instance deployment; the result page
// shows a friendly fallback if the token is missing/expired.

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const store = new Map<string, { info: MembershipInfo; expires: number }>();
let counter = 0;

function newToken(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

function sweep(now: number) {
  for (const [key, entry] of store) {
    if (entry.expires < now) store.delete(key);
  }
}

/** Stash a membership summary, return an opaque one-time-ish token. */
export function storeResult(info: MembershipInfo): string {
  const token = newToken();
  store.set(token, { info, expires: Date.now() + TTL_MS });
  if (store.size > 256) sweep(Date.now());
  return token;
}

/** Look up a stashed summary by token (does not consume it, so refresh works). */
export function getResult(token: string | null | undefined): MembershipInfo | null {
  if (!token) return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    store.delete(token);
    return null;
  }
  return entry.info;
}