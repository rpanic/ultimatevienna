import { describe, it, expect } from 'vitest';
import { splitByWeights, expenseRowLabel, resolveMemberColumns } from './reimburse';

// Tests for the pure, API-free helpers in reimburse.ts: the weighted split
// (splitByWeights), the debt-sheet row label (expenseRowLabel), and the
// member-column resolution against a transposed debt sheet (resolveMemberColumns
// — which reuses sheets.ts findMemberColumn / normalizeName).

const HEADER = ['Guthaben', 'Echo', 'Max Mustermann', 'Anna Anders', 'Rumble', 'Köstler Julius'];

function sum(shares: { amount: number }[]): number {
  return shares.reduce((s, e) => s + e.amount, 0);
}

describe('splitByWeights', () => {
  it('splits proportionally and rounds so the shares sum exactly to the total', () => {
    const shares = splitByWeights(100, [
      { name: 'A', weight: 1 },
      { name: 'B', weight: 1 },
      { name: 'C', weight: 1 },
    ]);
    expect(sum(shares)).toBe(100);
    // last positive-weight entry absorbs the rounding residual
    expect(shares.map((s) => s.amount)).toEqual([33.33, 33.33, 33.34]);
  });

  it('splits by unequal weights', () => {
    const shares = splitByWeights(100, [
      { name: 'A', weight: 1 },
      { name: 'B', weight: 2 },
    ]);
    expect(sum(shares)).toBe(100);
    expect(shares.map((s) => s.amount)).toEqual([33.33, 66.67]);
  });

  it('keeps order and pairs each share with its weight', () => {
    const shares = splitByWeights(50, [
      { name: 'A', weight: 3 },
      { name: 'B', weight: 1 },
    ]);
    expect(shares.map((s) => s.name)).toEqual(['A', 'B']);
    expect(shares[0].amount).toBeGreaterThan(shares[1].amount);
  });

  it('gives zero to entries with weight <= 0', () => {
    const shares = splitByWeights(90, [
      { name: 'A', weight: 1 },
      { name: 'B', weight: 0 },
      { name: 'C', weight: -3 },
      { name: 'D', weight: 1 },
    ]);
    expect(sum(shares)).toBe(90);
    expect(shares.find((s) => s.name === 'B')?.amount).toBe(0);
    expect(shares.find((s) => s.name === 'C')?.amount).toBe(0);
  });

  it('returns all-zero when the total is zero or negative', () => {
    expect(splitByWeights(0, [{ name: 'A', weight: 1 }]).every((s) => s.amount === 0)).toBe(true);
    expect(splitByWeights(-5, [{ name: 'A', weight: 1 }]).every((s) => s.amount === 0)).toBe(true);
  });

  it('returns all-zero when no entry has a positive weight', () => {
    const shares = splitByWeights(100, [{ name: 'A', weight: 0 }]);
    expect(shares.every((s) => s.amount === 0)).toBe(true);
  });

  it('handles an empty entry list', () => {
    expect(splitByWeights(100, [])).toEqual([]);
  });
});

describe('expenseRowLabel', () => {
  it('builds "<date> <description> (#<ID>)"', () => {
    expect(expenseRowLabel('R-0001', '2026-09-15', 'Turnier Salzburg'))
      .toBe('2026-09-15 Turnier Salzburg (#R-0001)');
  });

  it('collapses internal whitespace and trims', () => {
    expect(expenseRowLabel('R-0002', '2026-09-15', '  Hotel   &   Bahn ')).toBe('2026-09-15 Hotel & Bahn (#R-0002)');
  });

  it('trims the date to YYYY-MM-DD', () => {
    expect(expenseRowLabel('R-0003', '2026-09-15T20:30:00Z', 'Bälle')).toBe('2026-09-15 Bälle (#R-0003)');
  });
});

describe('resolveMemberColumns', () => {
  const rows = [HEADER];

  it('resolves names that appear in the header to their columns', () => {
    const { resolved, unresolved } = resolveMemberColumns(rows, ['Max Mustermann', 'Anna Anders']);
    expect(unresolved).toEqual([]);
    expect(resolved.map((r) => r.name).sort()).toEqual(['Anna Anders', 'Max Mustermann']);
    expect(resolved.find((r) => r.name === 'Max Mustermann')?.col).toBe(2);
    expect(resolved.find((r) => r.name === 'Anna Anders')?.col).toBe(3);
  });

  it('matches order-independently ("Julius Köstler" vs header "Köstler Julius")', () => {
    const { resolved, unresolved } = resolveMemberColumns(rows, ['Julius Köstler']);
    expect(unresolved).toEqual([]);
    expect(resolved[0].col).toBe(5);
  });

  it('reports names that do not match any header column', () => {
    const { resolved, unresolved } = resolveMemberColumns(rows, ['Max Mustermann', 'Nobody']);
    expect(unresolved).toEqual(['Nobody']);
    expect(resolved.map((r) => r.name)).toEqual(['Max Mustermann']);
  });

  it('matches team/section label columns too (they are header cells)', () => {
    // findMemberColumn matches any header cell — "Echo"/"Rumble" are labels, not
    // members, but they ARE in the header so they resolve. (In findCreditInSheet
    // they'd be filtered out because their balance cell is empty; here, where we
    // only check the column exists, they resolve. A submitter typing "Echo" as a
    // split name is a footgun we accept — real members won't do that.)
    const { resolved, unresolved } = resolveMemberColumns(rows, ['Echo']);
    expect(unresolved).toEqual([]);
    expect(resolved[0].col).toBe(1);
  });
});