// Pure, dependency-free helpers for the reimbursement feature (no googleapis,
// no Node APIs) so they can be imported by the client-side Vue form for live
// previews AND by the server-side reimburse.ts. Server-only helpers that need
// the Sheets/Drive clients stay in reimburse.ts.

export interface SplitEntry {
  name: string;
  weight: number;
}

export interface SplitShare {
  name: string;
  weight: number;
  amount: number;
}

/**
 * Split `total` across entries proportional to their weights, rounded to 2
 * decimals. The last positive-weight entry absorbs the rounding residual so the
 * shares always sum to exactly `total`. Entries with weight <= 0 get 0. Returns
 * a share per entry in the same order. Pure (no I/O).
 */
export function splitByWeights(total: number, entries: SplitEntry[]): SplitShare[] {
  const result: SplitShare[] = entries.map((e) => ({ ...e, amount: 0 }));
  if (total <= 0 || entries.length === 0) return result;

  const positive = result.filter((e) => e.weight > 0);
  if (positive.length === 0) return result;
  const weightSum = positive.reduce((s, e) => s + e.weight, 0);

  let lastPositiveIdx = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].weight > 0) { lastPositiveIdx = i; break; }
  }

  let allocated = 0;
  for (let i = 0; i < result.length; i++) {
    if (result[i].weight <= 0) continue;
    if (i === lastPositiveIdx) {
      result[i].amount = Math.round((total - allocated) * 100) / 100;
    } else {
      const amt = Math.round(((total * result[i].weight) / weightSum) * 100) / 100;
      result[i].amount = amt;
      allocated += amt;
    }
  }
  return result;
}
