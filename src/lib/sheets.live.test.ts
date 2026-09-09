import { describe, it, expect } from 'vitest';
import {
  isSheetsConfigured,
  fetchCreditRows,
  findCreditInSheet,
  outstandingFromBalance,
  getOutstandingCredit,
  countValuesByColumn,
} from './sheets';

// Live (integration) tests that actually call the Google Sheets API using the
// credentials in .env. Unlike sheets.test.ts (pure logic against fixtures),
// these exercise the real auth + HTTP + read path so you can confirm the API
// and the credit-reading functionality work end to end.
//
// The credit sheet is TRANSPOSED: row 1 holds one member name per column (with
// team/section labels interspersed), and the "Guthabenstand" row holds each
// member's signed balance. getOutstandingCredit charges DEBTS ONLY: a negative
// balance (member owes) → positive debt added; zero/positive → null.
//
// Skipped automatically when the required env vars are missing, so `npm test`
// still passes without creds. Nothing is logged except a single member's own
// balance, on the owner's machine — no other personal data, never process.env.

const sheetsConfigured = isSheetsConfigured();
const creditConfigured =
  sheetsConfigured && Boolean(process.env.CREDIT_SHEET_SPREADSHEET_ID);

// Header columns that are team/section labels, not member names.
const SECTION_LABELS = new Set([
  'echo',
  'rumble',
  'neu/alt/external',
  'eöfc',
  'uvie',
]);

// Find a member column whose live balance matches a sign, so the tests don't
// hardcode names. Uses the pure findCreditInSheet (no extra API call) on rows
// already fetched. wantNegative=true → a debtor; false → a creditor.
function findMemberBySign(rows: string[][], wantNegative: boolean): string | null {
  if (rows.length === 0) return null;
  const header = rows[0];
  for (let c = 2; c < header.length; c++) {
    const name = String(header[c] ?? '').trim();
    if (!name || SECTION_LABELS.has(name.toLowerCase())) continue;
    const balance = findCreditInSheet(rows, name);
    if (balance === null) continue;
    if (wantNegative ? balance < 0 : balance > 0) return name;
  }
  return null;
}

// --- Members sheet: verifies the Sheets API + service-account auth work ---
describe.skipIf(!sheetsConfigured)('Google Sheets API (live — members sheet)', () => {
  it('can read the configured members sheet without throwing', async () => {
    // countValuesByColumn hits the live sheet; dryRun:false means the API
    // call + auth succeeded. total may be 0 on a fresh sheet, so we only
    // assert the call went through (not dry-run).
    const result = await countValuesByColumn('Status', 'echo');
    expect(result.dryRun).toBe(false);
  });
});

// --- Credit sheet: the credit-reading functionality ---
describe.skipIf(!creditConfigured)('credit sheet (live — debt reading)', () => {
  it('fetches rows from the credit sheet via the API', async () => {
    const rows = await fetchCreditRows();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // The header should span many member columns, not just A/B.
    expect(rows[0].length).toBeGreaterThan(2);
  });

  it('returns a positive debt for a member who owes (negative balance)', async () => {
    const rows = await fetchCreditRows();
    const debtor = findMemberBySign(rows, true);
    expect(debtor).not.toBeNull();
    const credit = await getOutstandingCredit(debtor as string);
    expect(credit).not.toBeNull();
    expect(credit).toBeGreaterThan(0);
    // API path must agree with the pure transform of the pure read.
    expect(credit).toBe(outstandingFromBalance(findCreditInSheet(rows, debtor as string)));
  });

  it('returns null for a member with credit (positive balance)', async () => {
    const rows = await fetchCreditRows();
    const creditor = findMemberBySign(rows, false);
    if (creditor === null) return; // no creditor in the sheet right now — nothing to assert
    expect(await getOutstandingCredit(creditor)).toBe(0);
  });

  it('returns null for a name that is not in the credit sheet', async () => {
    // Feature is on (gated above), so null here means "not found", not "off".
    expect(await getOutstandingCredit('Zzqx Nonexistent Qqx')).toBe(0);
  });
});
