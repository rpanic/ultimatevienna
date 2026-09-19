import { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';
import { env } from '../email';
import {
  fetchCreditRows,
  findMemberColumn,
  getClient,
  getDriveClient,
  isSheetsConfigured,
  parseAmount,
} from '../sheets';
import {
  splitByWeights as splitByWeightsImpl,
  expenseRowLabel as expenseRowLabelImpl,
  type SplitEntry,
  type SplitShare,
} from './reimbursePure';

// Re-export the pure helpers (and their types) so callers can import everything
// from one place; the client-side Vue form imports splitByWeights directly from
// reimbursePure.ts to keep googleapis out of the client bundle.
export const splitByWeights = splitByWeightsImpl;
export const expenseRowLabel = expenseRowLabelImpl;
export type { SplitEntry, SplitShare };

// Reimbursement workflow: members submit a team expense (receipt + a weighted
// split between people); vorstand approves on a Basic-auth-protected admin page;
// on approval the split is written as ONE row into the existing credit/debt
// sheet (the Guthabenstand formula already sums it); payment status is tracked
// in a SEPARATE "Reimbursements" spreadsheet. Receipts are auto-filed into a
// Drive folder by the same service account used for Sheets.
//
// Configuration (env vars — see .env.example):
//   REIMBURSE_SPREADSHEET_ID  — the Reimbursements spreadsheet (one row per request)
//   REIMBURSE_TAB             — tab name (default: "Reimbursements")
//   REIMBURSE_DRIVE_FOLDER_ID — Drive folder to file receipts into
//   CREDIT_SHEET_SPREADSHEET_ID / CREDIT_SHEET_TAB — the existing debt sheet
//   (admin auth: ADMIN_USER / ADMIN_PASS, handled in middleware.ts)
//
// Like sheets.ts, when REIMBURSE_* env is unset the functions run in a dry-run
// mode (log instead of contacting Google/Drive) so the site stays demoable
// locally without credentials.

const REIMBURSE_SPREADSHEET_ID = env('REIMBURSE_SPREADSHEET_ID');
const REIMBURSE_TAB = env('REIMBURSE_TAB') ?? 'Reimbursements';
const DRIVE_FOLDER_ID = env('REIMBURSE_DRIVE_FOLDER_ID');

export function isReimburseConfigured(): boolean {
  return Boolean(REIMBURSE_SPREADSHEET_ID && DRIVE_FOLDER_ID && isSheetsConfigured());
}

export type ReimburseStatus = 'submitted' | 'approved' | 'paid' | 'rejected';

/** How the submitter chose to be reimbursed for the full total. 'credit' =
 *  vorstand adds it as credit to the Guthaben sheet by hand (offsets future
 *  dues); 'bankTransfer' = vorstand wires it. Preference only — the site does
 *  not perform the payout itself. */
export type PayoutMethod = 'credit' | 'bankTransfer';

export interface ReimbursementRecord {
  id: string;
  submittedAt: string;
  submitterName: string;
  submitterEmail: string;
  expenseDate: string;
  description: string;
  total: number;
  split: SplitShare[];
  /** Drive webViewLinks for the uploaded receipts (JSON array in the sheet). */
  receiptLinks: string[];
  status: ReimburseStatus;
  approvedAt?: string;
  paidAt?: string;
  payoutMethod: PayoutMethod;
}

// --- Member-column resolution (needs sheets.ts findMemberColumn) -----------

export interface ResolvedSplit {
  resolved: { name: string; col: number }[];
  unresolved: string[];
}

/**
 * Resolve each split name to a member column in the (transposed) debt sheet by
 * order-independent header match (findMemberColumn / normalizeName). Returns the
 * resolved names with their column indices plus any names that didn't match —
 * the caller blocks approval when `unresolved` is non-empty (no partial write).
 * Pure given the rows. Duplicate names resolve to the same column.
 */
export function resolveMemberColumns(rows: string[][], names: string[]): ResolvedSplit {
  const resolved: { name: string; col: number }[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const col = findMemberColumn(rows, name);
    if (col < 0) unresolved.push(name);
    else resolved.push({ name, col });
  }
  return { resolved, unresolved };
}

// --- Reimbursements spreadsheet (separate) ---------------------------------

// Column layout of the Reimbursements tab (header in row 1):
//   A ID | B SubmittedAt | C SubmitterName | D SubmitterEmail | E ExpenseDate
//   F Description | G Total | H Split(JSON) | I ReceiptLinks | J Status
//   K ApprovedAt | L PaidAt | M PayoutMethod (credit | bankTransfer)
const COL = {
  id: 0, submittedAt: 1, submitterName: 2, submitterEmail: 3, expenseDate: 4,
  description: 5, total: 6, split: 7, receiptLink: 8, status: 9, approvedAt: 10, paidAt: 11,
  payoutMethod: 12,
} as const;

function rowToRecord(r: string[]): ReimbursementRecord | null {
  const id = String(r[COL.id] ?? '').trim();
  if (!id) return null;
  let split: SplitShare[] = [];
  try {
    const parsed = JSON.parse(String(r[COL.split] ?? '[]'));
    if (Array.isArray(parsed)) split = parsed as SplitShare[];
  } catch { split = []; }
  // Receipt links are stored as a JSON array; fall back to a single link for
  // rows written before multi-file support (a bare URL string).
  let receiptLinks: string[] = [];
  const rawLink = String(r[COL.receiptLink] ?? '').trim();
  if (rawLink) {
    if (rawLink.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawLink);
        if (Array.isArray(parsed)) receiptLinks = parsed.filter((x) => typeof x === 'string');
      } catch { receiptLinks = []; }
    } else {
      receiptLinks = [rawLink];
    }
  }
  return {
    id,
    submittedAt: String(r[COL.submittedAt] ?? ''),
    submitterName: String(r[COL.submitterName] ?? ''),
    submitterEmail: String(r[COL.submitterEmail] ?? ''),
    expenseDate: String(r[COL.expenseDate] ?? ''),
    description: String(r[COL.description] ?? ''),
    total: parseAmount(String(r[COL.total] ?? '')) ?? 0,
    split,
    receiptLinks,
    status: (String(r[COL.status] ?? 'submitted') as ReimburseStatus),
    approvedAt: r[COL.approvedAt] ? String(r[COL.approvedAt]) : undefined,
    paidAt: r[COL.paidAt] ? String(r[COL.paidAt]) : undefined,
    // Pre-existing rows (written before this field) have no M value; they
    // defaulted to an external transfer, so coerce unknown/empty to bankTransfer.
    payoutMethod:
      String(r[COL.payoutMethod] ?? '').trim() === 'credit' ? 'credit' : 'bankTransfer',
  };
}

/** Next monotonic ID ("R-0001" …), scanned from column A. Dry-run: a pseudo id. */
export async function nextReimburseId(): Promise<string> {
  if (!isReimburseConfigured()) return `R-DRY-${Date.now().toString(36)}`;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REIMBURSE_SPREADSHEET_ID,
    range: `${REIMBURSE_TAB}!h:A`,
  });
  const col = (res.data.values ?? []) as string[][];
  let max = 0;
  for (const row of col) {
    const m = String(row[0] ?? '').trim().match(/^R-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `R-${String(max + 1).padStart(4, '0')}`;
}

export interface NewReimbursement {
  id: string;
  submitterName: string;
  submitterEmail: string;
  expenseDate: string;
  description: string;
  total: number;
  split: SplitShare[];
  receiptLink: string;
  payoutMethod: PayoutMethod;
}

/** Append a new reimbursement row with Status = "submitted". */
export async function appendReimbursement(rec: NewReimbursement): Promise<{ dryRun: boolean }> {
  const values = [[
    rec.id,
    new Date().toISOString(),
    rec.submitterName,
    rec.submitterEmail,
    rec.expenseDate,
    rec.description,
    rec.total,
    JSON.stringify(rec.split),
    rec.receiptLink,
    'submitted',
    '',
    '',
    rec.payoutMethod,
  ]];
  if (!isReimburseConfigured()) {
    console.warn('[reimburse] not configured — dry run. Would append:', rec);
    return { dryRun: true };
  }
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: REIMBURSE_SPREADSHEET_ID,
    range: `${REIMBURSE_TAB}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  console.log('[reimburse] appended row:', rec.id);
  return { dryRun: false };
}

/** Read all reimbursement rows (newest last). Empty in dry-run / when off. */
export async function listReimbursements(): Promise<ReimbursementRecord[]> {
  if (!isReimburseConfigured()) return [];
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REIMBURSE_SPREADSHEET_ID,
    range: `${REIMBURSE_TAB}!A2:M`,
  });
  const rows = (res.data.values ?? []) as string[][];
  const out: ReimbursementRecord[] = [];
  for (const r of rows) {
    const rec = rowToRecord(r);
    if (rec) out.push(rec);
  }
  return out;
}

/** Find a reimbursement's 1-based row number by ID (scans column A). */
async function findReimburseRowNumber(id: string): Promise<number | null> {
  if (!isReimburseConfigured()) return null;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REIMBURSE_SPREADSHEET_ID,
    range: `${REIMBURSE_TAB}!A:A`,
  });
  const col = (res.data.values ?? []) as string[][];
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0] ?? '').trim() === id) return i + 1;
  }
  return null;
}

export interface StatusUpdate {
  status?: ReimburseStatus;
  approvedAt?: string;
  paidAt?: string;
}

/** Update a reimbursement's Status / ApprovedAt / PaidAt cells by ID. */
export async function updateReimburseStatus(
  id: string,
  fields: StatusUpdate,
): Promise<{ dryRun: boolean; found: boolean }> {
  if (!isReimburseConfigured()) {
    console.warn('[reimburse] not configured — dry run. Would update:', id, fields);
    return { dryRun: true, found: true };
  }
  const row = await findReimburseRowNumber(id);
  if (row === null) return { dryRun: false, found: false };
  const data: { range: string; values: (string)[][] }[] = [];
  if (fields.status !== undefined) data.push({ range: `${REIMBURSE_TAB}!J${row}`, values: [[fields.status]] });
  if (fields.approvedAt !== undefined) data.push({ range: `${REIMBURSE_TAB}!K${row}`, values: [[fields.approvedAt]] });
  if (fields.paidAt !== undefined) data.push({ range: `${REIMBURSE_TAB}!L${row}`, values: [[fields.paidAt]] });
  if (data.length === 0) return { dryRun: false, found: true };
  const sheets = getClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: REIMBURSE_SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  return { dryRun: false, found: true };
}

// --- Debt-sheet write on approval ------------------------------------------

export interface ExpenseWriteInput {
  id: string;
  expenseDate: string;
  description: string;
  split: SplitShare[];
}

export interface ExpenseWriteResult {
  dryRun: boolean;
  /** Names that didn't resolve to a member column — blocks the write. */
  unresolved: string[];
  written: boolean;
}

/**
 * On approval, append ONE row to the existing credit/debt sheet: col A =
 * "<date> <description> (#<ID>)", and each resolved member's column = their share
 * (a number = spending; the Guthabenstand formula sums it). No partial write: if
 * any split name doesn't resolve to a member column, nothing is written and the
 * unresolved names are returned so the admin can fix them. Dry-run (off / no
 * sheet) logs instead of writing. The submitter is reimbursed the full total by
 * the club when marked "paid" — no +entry for the payer here.
 */
export async function appendApprovedExpenseToDebtSheet(
  input: ExpenseWriteInput,
): Promise<ExpenseWriteResult> {
  if (!isSheetsConfigured()) {
    console.warn('[reimburse] debt sheet not configured — dry run. Would write expense row:', input);
    return { dryRun: true, unresolved: [], written: false };
  }
  const rows = await fetchCreditRows();
  if (rows.length === 0) {
    // Credit sheet configured but empty — treat every name as unresolved so a
    // real misconfiguration surfaces instead of silently approving.
    return { dryRun: false, unresolved: input.split.map((s) => s.name), written: false };
  }
  const { resolved, unresolved } = resolveMemberColumns(rows, input.split.map((s) => s.name));
  if (unresolved.length > 0) return { dryRun: false, unresolved, written: false };

  const label = expenseRowLabel(input.id, input.expenseDate, input.description);
  let maxCol = 0;
  for (const r of resolved) maxCol = Math.max(maxCol, r.col);
  const rowArr: (string | number)[] = new Array(maxCol + 1).fill('');
  rowArr[0] = label;
  for (const r of resolved) {
    const share = input.split.find((s) => s.name === r.name);
    rowArr[r.col] = share ? share.amount : 0;
  }

  const creditSheetId = env('CREDIT_SHEET_SPREADSHEET_ID');
  const tab = env('CREDIT_SHEET_TAB');
  const appendRange = tab ? `${tab}!A:A` : 'A:A';
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: creditSheetId,
    range: appendRange,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArr] },
  });
  console.log('[reimburse] wrote debt-sheet expense row:', label);
  return { dryRun: false, unresolved: [], written: true };
}

// --- Drive receipt upload ---------------------------------------------------

export interface ReceiptFile {
  name: string;
  type: string;
  buffer: ArrayBuffer;
}

function sanitizeFileName(s: string): string {
  // Keep alphanumerics, spaces, dots, dashes, underscores and German umlauts;
  // strip anything else (path separators, etc.). Collapse whitespace.
  return s
    .replace(/[^a-zA-Z0-9 ._\-äöüÄÖÜß]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extFor(name: string): string {
  const m = name.match(/\.([a-zA-Z0-9]{1,5})$/);
  return m ? '.' + m[1].toLowerCase() : '';
}

/**
 * Upload a receipt to the configured Drive folder and return its webViewLink.
 * Filename: "<expenseDate> <submitterName> <id> <original file name>", sanitized
 * — the original name is included so multiple files in one request are
 * distinguishable and don't collide. Dry-run logs. Call once per file; the
 * caller collects the links into a JSON array for the Reimbursements sheet.
 */
export async function uploadReceiptToDrive(
  file: ReceiptFile,
  meta: { id: string; submitterName: string; expenseDate: string },
): Promise<{ dryRun: boolean; link?: string }> {
  if (!isReimburseConfigured()) {
    console.warn('[reimburse] not configured — dry run. Would upload receipt:', file.name);
    return { dryRun: true };
  }
  const name = sanitizeFileName(`${meta.expenseDate} ${meta.submitterName} ${meta.id} ${file.name}`)
    || `${meta.id}${extFor(file.name)}`;
  const buf = Buffer.from(file.buffer);
  const stream = new Readable();
  stream.push(buf);
  stream.push(null);

  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: { name, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType: file.type, body: stream },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  } as drive_v3.Params$Resource$Files$Create);
  const link = res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}/view`;
  console.log('[reimburse] uploaded receipt:', name, '→', link);
  return { dryRun: false, link };
}
