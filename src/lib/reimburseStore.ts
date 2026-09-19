import type { SplitShare, PayoutMethod } from './reimburse';

// Short-lived, in-memory store that hands a reimbursement submission summary
// from the submit endpoint to the post-submit done page — the same pattern as
// resultStore.ts (used by the onboarding flow). The submit route computes the
// summary (ID, split, total, …) and stashes it under an opaque token; the
// browser is redirected to /reimburse/done?t=<token>, and the done page reads it
// back. This keeps the data out of the URL.
//
// Caveat: in-memory, so it does not survive a server restart and is not shared
// across instances. Fine for a single-instance deployment; the done page shows
// a friendly fallback if the token is missing/expired.

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ReimburseSubmission {
  id: string;
  submitterName: string;
  submitterEmail: string;
  expenseDate: string;
  description: string;
  total: number;
  split: SplitShare[];
  receiptCount: number;
  receiptUploaded: boolean;
  status: 'submitted';
  payoutMethod: PayoutMethod;
}

const store = new Map<string, { info: ReimburseSubmission; expires: number }>();
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

/** Stash a reimbursement submission summary, return an opaque token. */
export function storeReimburse(info: ReimburseSubmission): string {
  const token = newToken();
  store.set(token, { info, expires: Date.now() + TTL_MS });
  if (store.size > 256) sweep(Date.now());
  return token;
}

/** Look up a stashed submission by token (does not consume it, so refresh works). */
export function getReimburse(token: string | null | undefined): ReimburseSubmission | null {
  if (!token) return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    store.delete(token);
    return null;
  }
  return entry.info;
}