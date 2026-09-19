import { Readable } from 'node:stream';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
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
  expenseRowLabel,
  type SplitEntry,
  type SplitShare,
} from './reimbursePure';

// Re-export the pure helpers (and their types) so callers can import everything
// from one place; the client-side Vue form imports splitByWeights directly from
// reimbursePure.ts to keep googleapis out of the client bundle.
export const splitByWeights = splitByWeightsImpl;
export { expenseRowLabel };
export type { SplitEntry, SplitShare };

// Reimbursement workflow: members submit a team expense (receipt + a weighted
// split between people); vorstand approves on a Basic-auth-protected admin page;
// on approval the split is staged as ONE ready-to-paste row in a tab of the
// Reimbursements spreadsheet (the service account can't write to the debt sheet,
// so the admin copies that row into the Guthaben sheet by hand); payment status
// is tracked in the same "Reimbursements" spreadsheet. Receipts are auto-filed
// into a Drive folder by the same service account used for Sheets.
//
// Configuration (env vars — see .env.example):
//   REIMBURSE_SPREADSHEET_ID  — the Reimbursements spreadsheet (requests + staged rows)
//   REIMBURSE_TAB             — requests tab (default: "Reimbursements")
//   REIMBURSE_DEBT_TAB        — staging tab for rows to paste into the debt sheet (default: "DebtRows")
//   REIMBURSE_DRIVE_FOLDER_ID — Drive folder to file receipts into
//   CREDIT_SHEET_SPREADSHEET_ID / CREDIT_SHEET_TAB — the existing debt sheet
//       (READ-ONLY for the service account — Viewer access — used only to resolve
//       member columns; the SA does NOT write to it)
//   (admin auth: ADMIN_USER / ADMIN_PASS, handled in middleware.ts)
//
// Like sheets.ts, when REIMBURSE_* env is unset the functions run in a dry-run
// mode (log instead of contacting Google/Drive) so the site stays demoable
// locally without credentials.

const REIMBURSE_SPREADSHEET_ID = env('REIMBURSE_SPREADSHEET_ID');
const REIMBURSE_TAB = env('REIMBURSE_TAB') ?? 'Reimbursements';
// Tab (inside the Reimbursements spreadsheet) where approved expense rows are
// staged for the admin to copy-paste into the debt/Guthaben sheet. The service
// account has write access to the Reimbursements spreadsheet but NOT to the debt
// sheet, so the row is staged here instead of appended directly.
const DEBT_TAB = env('REIMBURSE_DEBT_TAB') ?? 'DebtRows';
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

/**
 * The reimbursement summary rendered into the first emails (submitter
 * confirmation + vorstand notification) as an HTML card — mirrors the join flow's
 * renderMembershipEmail. JSON-serializable; the email component imports this as a
 * type only (no runtime import of googleapis into the email render).
 */
export interface ReimburseEmailSummary {
  id: string;
  submitterName: string;
  submitterEmail: string;
  expenseDate: string;
  description: string;
  total: number;
  split: SplitShare[];
  payoutMethod: PayoutMethod;
  receiptCount: number;
  /** Drive webViewLinks for the uploaded receipts (shown to the admin). */
  receiptLinks: string[];
  /** Whether the receipts were actually uploaded to Drive (false in a dry run).
   *  Optional — defaults to true. The member variant uses it to note a dry run on
   *  the post-submit done page; the admin variant derives dry-run from empty
   *  receiptLinks. */
  receiptUploaded?: boolean;
}

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

// --- Stage the approved expense row (for manual paste into the debt sheet) ---

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
 * On approval, build the ONE row that belongs in the credit/debt sheet — col A =
 * "<date> <description> (#<ID>)", each resolved member's column = their share (a
 * number = spending; the Guthabenstand formula sums it) — and APPEND it to the
 * staging tab (REIMBURSE_DEBT_TAB) of the Reimbursements spreadsheet, ready for
 * the admin to copy-paste into the Guthaben sheet. The service account has
 * read-only access to the debt sheet (used here only to resolve member columns
 * via fetchCreditRows / findMemberColumn) and no write access, which is why the
 * row is staged in the Reimbursements sheet instead of written directly.
 *
 * Same checks as a direct write: no partial row — if any split name doesn't
 * resolve to a member column, nothing is staged and the unresolved names are
 * returned so the admin can fix them. The row is padded to the debt sheet's full
 * header width so every staged row is uniform and pastes cleanly into the right
 * columns. Dry-run (no SA creds, or no Reimbursements sheet) logs instead.
 */
export async function stageApprovedExpenseRow(
  input: ExpenseWriteInput,
): Promise<ExpenseWriteResult> {
  if (!isSheetsConfigured()) {
    console.warn('[reimburse] sheets not configured — dry run. Would stage expense row:', input);
    return { dryRun: true, unresolved: [], written: false };
  }
  // Read the debt sheet (READ-ONLY) to resolve each split name to a member column.
  const rows = await fetchCreditRows();
  if (rows.length === 0) {
    // Debt sheet configured but empty — treat every name as unresolved so a real
    // misconfiguration (or missing read access) surfaces instead of silently
    // approving with no columns to align against.
    return { dryRun: false, unresolved: input.split.map((s) => s.name), written: false };
  }
  const { resolved, unresolved } = resolveMemberColumns(rows, input.split.map((s) => s.name));
  if (unresolved.length > 0) return { dryRun: false, unresolved, written: false };

  const label = expenseRowLabel(input.id, input.expenseDate, input.description);
  // Pad to the debt sheet's full header width so the row aligns column-for-column
  // when pasted, regardless of which members are in the split.
  const width = rows[0].length;
  const rowArr: (string | number)[] = new Array(Math.max(width, 1)).fill('');
  rowArr[0] = label;
  for (const r of resolved) {
    const share = input.split.find((s) => s.name === r.name);
    rowArr[r.col] = share ? share.weight : 0;
  }

  if (!isReimburseConfigured()) {
    console.warn('[reimburse] reimburse sheet not configured — dry run. Would stage row:', rowArr);
    return { dryRun: true, unresolved: [], written: false };
  }
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: REIMBURSE_SPREADSHEET_ID,
    range: `${DEBT_TAB}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArr] },
  });
  console.log('[reimburse] staged debt-sheet row in', DEBT_TAB, ':', label);
  return { dryRun: false, unresolved: [], written: true };
}

/**
 * Edit URL of the Reimbursements spreadsheet (where the staging tab lives), for
 * the admin "open sheet" link so vorstand can reach the staged rows to paste.
 * Empty string when the sheet isn't configured.
 */
export function reimburseSheetUrl(): string {
  return REIMBURSE_SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${REIMBURSE_SPREADSHEET_ID}/edit`
    : '';
}

/** Name of the staging tab (REIMBURSE_DEBT_TAB) for the admin "paste the row" note. */
export function reimburseDebtTabName(): string {
  return DEBT_TAB;
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
  const name = sanitizeFileName(`${meta.id} ${file.name}`)
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

// Re-use one Container instance across renders (mirrors renderMembershipEmail).
let cachedContainer: Awaited<ReturnType<typeof AstroContainer.create>> | null = null;
async function getContainer() {
  if (!cachedContainer) cachedContainer = await AstroContainer.create();
  return cachedContainer;
}

/**
 * Render the reimbursement summary as a full HTML document string, using Astro's
 * Container API to render ReimbursementEmail.astro server-side. `variant` is
 * 'member' (submitter confirmation — no Drive links) or 'admin' (vorstand
 * notification — with Drive receipt links + the admin review URL).
 *
 * The .astro component is imported dynamically (not at module top level) so that
 * importing this module in a plain Vitest environment (no Astro Vite plugin)
 * doesn't try to parse the .astro file — the import is only resolved when this
 * function is actually called, which never happens during the unit tests.
 */
export async function renderReimbursementEmail(
  summary: ReimburseEmailSummary,
  variant: 'member' | 'admin',
  adminUrl?: string,
): Promise<string> {
  const container = await getContainer();
  const { default: ReimbursementEmail } = await import('../../emails/ReimbursementEmail.astro');
  return container.renderToString(ReimbursementEmail, { props: { summary, variant, adminUrl } });
}
