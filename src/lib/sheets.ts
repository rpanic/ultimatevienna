import { google, type sheets_v4 } from 'googleapis';

// Google Sheets client backed by a service account.
//
// Configuration (env vars — see .env.example):
//   GOOGLE_SHEETS_SPREADSHEET_ID  — the sheet ID from its URL
//   GOOGLE_SHEETS_CLIENT_EMAIL    — service account email (xxx@xxx.iam.gserviceaccount.com)
//   GOOGLE_SHEETS_PRIVATE_KEY     — service account private key (the JSON "private_key" field)
//   MEMBERS_SHEET_TAB             — members tab name (default: "Members")
//
// Share the spreadsheet with the service account email (Editor) so it can
// read and write. The Members tab must have a header row in this exact order:
//
//   A Timestamp | B FirstName | C LastName | D Email | E BirthDate
//   F Phone | G Address | H OtherClubs | I PayNationalFee | J Student | K Club
//   L Status | M AlreadyPaidClub | N AlreadyPaidSymbiose
//
// appendMember writes these values (the alreadyPaidClub selection is encoded
// into K + L, not written as a literal value under its own column):
//   K Club   — the assigned club; suffixed " - alt" when alreadyPaidClub
//              !== none (e.g. "UVie - alt"), otherwise the bare club name.
//   L Status — "claimed" when alreadyPaidClub !== none, else "pending".
//   M        — "claimed" when alreadyPaidSymbiose, else "pending".
//   N        — not written (reserved).
//
// Team values are "echo" or "foxes" (implied by the tab). Student is "yes"/"no"
// (university / high school students pay a reduced membership fee). When the
// env vars are not set, the client
// runs in a "dry run" mode: it logs what it would write / look up instead of
// contacting Google, so the site stays demoable locally without credentials.
// In production, set the env vars.
//
// Note: the post-onboarding welcome message is NOT read from the sheet — it
// is hardcoded in the welcomeMessage action (src/actions/index.ts).

const SHEET_TAB_ECHO = env('MEMBERS_SHEET_TAB_ECHO') ?? 'EchoRumble';
const SHEET_TAB_FOXES = env('MEMBERS_SHEET_TAB_FOXES') ?? 'Foxes';

const SPREADSHEET_ID = env('GOOGLE_SHEETS_SPREADSHEET_ID');
const CLIENT_EMAIL = env('GOOGLE_SHEETS_CLIENT_EMAIL');
const PRIVATE_KEY = normalizePrivateKey(env('GOOGLE_SHEETS_PRIVATE_KEY'));

// Service-account private keys come in a few forms and Node's crypto signer
// rejects anything that isn't a clean PEM, throwing
// `ERR_OSSL_UNSUPPORTED` (DECODER routines::unsupported). This normalizes what
// the user pasted into .env into a valid PKCS#8 PEM:
//   - literal "\n" escape sequences → real newlines
//   - bare base64 body (no PEM header/footer) → wrapped in
//     -----BEGIN/END PRIVATE KEY----- markers, re-wrapped at 64 chars
//   - already-wrapped PEM → left untouched
function normalizePrivateKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let key = raw.replace(/\\n/g, '\n').trim();
  if (key.includes('-----BEGIN')) return key;
  // Bare base64: strip any stray whitespace/newlines, then re-wrap as PEM.
  const body = key.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

// Read a server-side env var from import.meta.env (populated by Vite in dev
// from .env) or process.env (populated by the host in production via the Node
// adapter). Reading at call time would be safer than module-load time, but
// these are read once at first use — fine for a long-running server.
function env(name: string): string | undefined {
  const fromImport = (import.meta.env as Record<string, string | undefined>)[name];
  if (fromImport) return fromImport;
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  return undefined;
}

export function isSheetsConfigured(): boolean {
  return Boolean(SPREADSHEET_ID && CLIENT_EMAIL && PRIVATE_KEY);
}

export type Club = "UVie" | "EÖFC";

// Column order must match the Members header row documented above.
const COLUMNS = [
  'Timestamp',
  'FirstName',
  'LastName',
  'Email',
  'BirthDate',
  'Phone',
  'Address',
  'OtherClubs',
  'PayNationalFee',
  'Student',
  'Club',
  'Status',
  'AlreadyPaidClub',
  'AlreadyPaidSymbiose',
] as const;

export type Team = 'echo' | 'foxes';

// Re-use a single authorized client across calls.
let cachedClient: sheets_v4.Sheets | null = null;

function getClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

// Fetch every data row (excluding the header row) from the Members tab as arrays
// of cell strings, aligned to COLUMNS. Shared by the lookup and the analysis
// helpers so we only read the sheet once per call. Returns [] in dry-run mode.
async function fetchAllRows(team: "echo" | "foxes"): Promise<{ rows: string[][]; dryRun: boolean }> {
  if (!isSheetsConfigured()) {
    console.warn('[sheets] not configured — dry run. No rows to read.');
    return { rows: [], dryRun: true };
  }
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${team === "echo" ? SHEET_TAB_ECHO : SHEET_TAB_FOXES}!A2:Z`,
  });
  return { rows: (res.data.values ?? []) as string[][], dryRun: false };
}

export interface MemberRow {
  team: Team;
  firstName: string;
  lastName: string;
  email: string;
  birthDate: string;
  phone?: string;
  address?: string;
  otherClubs?: string;
  payNationalFee: boolean;
  /** University / high school student — pays a reduced membership fee. */
  student: boolean;
  /** Club the member says they already paid this season's membership fee to
   * ('none' if not already paid). Drives removing that club's payment from the
   * confirmation; stored in sheet column M. */
  alreadyPaidClub: 'none' | Club;
  /** Echo/rumble only: the member says they already paid the Symbiosepauschale
   * to the OTHER club this season, so that payment is dropped too. Stored in
   * sheet column N as "yes"/"no". Always false for foxes. */
  alreadyPaidSymbiose: boolean;
}

export interface AppendResult {
  success: boolean;
  dryRun: boolean;
  club?: Club;
  /** The member row that was (or would be) written — drives membership.ts. */
  row?: MemberRow;
}

/** Append a new member registration as a row, with Status = "pending". */
export async function appendMember(row: MemberRow): Promise<AppendResult> {
  if (!isSheetsConfigured()) {
    console.warn('[sheets] not configured — dry run. Would append row:', row);
    return { success: true, dryRun: true, row };
  }

  const club = row.team === "foxes" ? "UVie" : (row.alreadyPaidClub !== "none" ? row.alreadyPaidClub : await getNextEchoRumbleClub());
  const clubSheetString = row.alreadyPaidClub !== "none" ? club + " - alt" : club;

  const values = [[
    new Date().toISOString(),
    row.firstName,
    row.lastName,
    row.email,
    row.birthDate,
    row.phone ?? '',
    row.address ?? '',
    row.otherClubs ?? '',
    row.payNationalFee ? 'yes' : 'no',
    row.student ? 'yes' : 'no',
    clubSheetString,
    row.alreadyPaidClub !== "none" ? "claimed" : "pending",
    row.alreadyPaidSymbiose ? 'claimed' : 'pending',
  ]];


  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${row.team === "echo" ? SHEET_TAB_ECHO : SHEET_TAB_FOXES}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  console.log('[sheets] appended member row for:', row.email);
  return { success: true, dryRun: false, club, row };
}

export interface MemberLookup {
  found: boolean;
  status?: string;
  dryRun: boolean;
}

/**
 * Find a member by email (case-insensitive). Returns the Status column value.
 * Used by the status action; the action never exposes `found` to the client
 * (GDPR) — it emails the result to the address owner instead.
 */
export async function findMemberByEmail(email: string): Promise<MemberLookup> {
  const result = await findMemberByEmailAndTeam(email, "echo");
  if(result.found) {
    return result;
  }
  return await findMemberByEmailAndTeam(email, "foxes");
}

export async function findMemberByEmailAndTeam(email: string, team: "echo" | "foxes"): Promise<MemberLookup> {
  const { rows, dryRun } = await fetchAllRows(team);
  if (dryRun) {
    console.warn('[sheets] not configured — dry run. Would look up:', email);
    return { found: false, dryRun: true };
  }

  const emailCol = COLUMNS.indexOf('Email');
  const statusCol = COLUMNS.indexOf('Status');

  const target = email.trim().toLowerCase();
  for (const r of rows) {
    const cell = String(r[emailCol] ?? '').trim().toLowerCase();
    if (cell === target) {
      return { found: true, status: String(r[statusCol] ?? 'unknown'), dryRun: false };
    }
  }
  return { found: false, dryRun: false };
}

export interface ColumnFrequency {
  column: string;
  total: number;
  counts: Record<string, number>;
  dryRun: boolean;
}

export async function getNextEchoRumbleClub(): Promise<Club> {
  const counts = await countValuesByColumn("Club", "echo");

  const uvie = counts.counts["UVie"] ?? 0;
  const eoefc = counts.counts["EÖFC"] ?? 0;

  return eoefc > uvie ? "UVie" : "EÖFC";
}

/**
 * Tally how often each value occurs in one column of the Members tab — e.g.
 * `countValuesByColumn('Team')` -> { 'echo': 12, 'foxes': 7 }, or
 * `countValuesByColumn('Status')` -> { 'pending': 18, 'approved': 1 }.
 *
 * `column` is matched case-insensitively against the COLUMNS header and must be
 * one of them (otherwise throws). Empty cells are skipped; `total` is the count
 * of non-empty cells tallied. Runs against the live sheet, or returns an empty
 * tally in dry-run mode when the env vars aren't set.
 */
export async function countValuesByColumn(column: string, team: "echo" | "foxes"): Promise<ColumnFrequency> {
  const colIndex = COLUMNS.findIndex(
    (c) => c.toLowerCase() === column.trim().toLowerCase(),
  );
  if (colIndex < 0) {
    throw new Error(`Unknown column "${column}". Expected one of: ${COLUMNS.join(', ')}`);
  }

  const { rows, dryRun } = await fetchAllRows(team);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows.slice(1)) {
    const value = String(row[colIndex] ?? '').trim();
    if (!value) continue; // skip empty cells
    counts[value] = (counts[value] ?? 0) + 1;
    total++;
  }
  return { column: COLUMNS[colIndex], total, counts, dryRun };
}

// ---------------------------------------------------------------------------
// Credit sheet: a SEPARATE spreadsheet (CREDIT_SHEET_SPREADSHEET_ID) listing
// members' outstanding amounts owed to UVie. Column A holds names, column B
// holds the outstanding amount (a formula — its computed value is read). On
// registration the member's full name is looked up there; if a numeric amount
// is found it's added as a line item to the UVie payment (see
// membership.ts: getMembershipInfo). The same service account must have access
// to this spreadsheet too (share it as Editor). When the env var isn't set the
// feature is off and the lookup silently returns null — no error.
// ---------------------------------------------------------------------------

/**
 * Canonicalize a name for order-independent matching: lowercase, split on
 * whitespace/commas, drop empties, sort the tokens. This matches "First Last",
 * "Last First", and "Last, First" all to the same key, so the credit sheet's
 * formatting doesn't have to match the member's first/last order.
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

/**
 * Parse a German-formatted amount string from a sheet cell into a number.
 * Handles "50", "50,00", "1.234,56", "€ 50,00", "-10,00" (dot = thousands,
 * comma = decimal). Returns null for empty or non-numeric cells.
 */
function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/[^0-9,.\-]/g, '');
  if (!s || s === '-') return null;
  let norm = s;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    norm = s.replace(/\./g, '').replace(',', '.'); // German: dot=thousands, comma=decimal
  } else if (hasComma) {
    norm = s.replace(',', '.'); // comma is the decimal separator
  }
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure core of the credit lookup. The credit sheet is laid out TRANSPOSED:
 *   - Row 1 (header, rows[0]): the first cell is "Guthaben", then team/section
 *     labels ("Echo", "Rumble", "Neu/Alt/External", "EÖFC", "UVie"), with one
 *     MEMBER NAME per column in between. Each member occupies their own column.
 *   - Column A (rows[*][0]): row labels. The row whose label is "Guthabenstand"
 *     holds each member's signed credit balance (deposits − their share of the
 *     spending) — a formula, whose computed value the Sheets API returns.
 *
 * So to read a member's credit we find their COLUMN by matching the header row,
 * then read the "Guthabenstand" ROW at that column. Name matching against the
 * header is order-independent (normalizeName) so "Last First" / "Last, First"
 * in the header still match a "First Last" lookup; amount parsing is
 * German-formatted (parseAmount). Returns null when the sheet is empty, the
 * name isn't in the header, there is no "Guthabenstand" row, or the balance
 * cell has no numeric value. Extracted from getOutstandingCredit so it can be
 * tested without the Sheets API (see sheets.test.ts).
 */
export function findCreditInSheet(rows: string[][], fullName: string): number | null {
  const target = normalizeName(fullName);
  if (!target || rows.length === 0) return null;

  // 1. Find the member's column by matching the header (row 1).
  const header = rows[0];
  let memberCol = -1;
  for (let c = 0; c < header.length; c++) {
    if (normalizeName(String(header[c] ?? '')) === target) {
      memberCol = c;
      break;
    }
  }
  if (memberCol < 0) return null;

  // 2. Find the "Guthabenstand" (balance) row by its column-A label.
  let balanceRow = -1;
  for (let r = 0; r < rows.length; r++) {
    if (String(rows[r][0] ?? '').trim().toLowerCase() === 'guthabenstand') {
      balanceRow = r;
      break;
    }
  }
  if (balanceRow < 0) return null;

  // 3. Parse the balance cell at [balanceRow][memberCol].
  return parseAmount(String(rows[balanceRow]?.[memberCol] ?? ''));
}

/**
 * Map a member's signed "Guthabenstand" balance to the outstanding debt to add
 * to their UVie payment. The balance is (deposits − their share of spending):
 *   - negative → the member owes UVie → return the positive debt.
 *   - zero or positive → paid up, or UVie owes them (credit) → return null.
 * Decided with the user: charge debts only. A prior credit is NOT applied
 * against the membership fee — only outstanding debts are collected. Pure so
 * it can be unit-tested (see sheets.test.ts) independently of the Sheets API.
 */
export function outstandingFromBalance(balance: number | null): number {
  if (balance === null || balance >= 0) return 0;
  return -balance;
}

/**
 * Fetch the credit sheet's rows directly from the API. The sheet is
 * transposed (members are columns), so this reads the FULL width (A:ZZ) — not
 * just A:B. Returns [] when the feature is off (no CREDIT_SHEET_SPREADSHEET_ID
 * or sheets not configured). On a real API error this throws, so a live test
 * (see sheets.live.test.ts) surfaces auth/access failures instead of silently
 * looking like an empty sheet. An optional `range` override is accepted for
 * diagnostics.
 */
export async function fetchCreditRows(range?: string): Promise<string[][]> {
  const creditSheetId = env('CREDIT_SHEET_SPREADSHEET_ID');
  if (!creditSheetId || !isSheetsConfigured()) return [];
  const tab = env('CREDIT_SHEET_TAB');
  const resolvedRange = range ?? (tab ? `${tab}!A:ZZ` : 'A:ZZ');
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: creditSheetId, range: resolvedRange });
  return (res.data.values ?? []) as string[][];
}

/**
 * Look up the outstanding debt a member owes UVie by full name in the credit
 * sheet. Returns a positive amount when the member's "Guthabenstand" balance
 * is negative (they owe), or null when the feature is off, the name isn't
 * found, there is no "Guthabenstand" row, the balance cell has no numeric
 * value, or the balance is zero/positive (paid up or has credit — no debt to
 * collect). Never throws.
 */
export async function getOutstandingCredit(fullName: string): Promise<number | null> {
  if (!env('CREDIT_SHEET_SPREADSHEET_ID') || !isSheetsConfigured()) return null;
  if (!normalizeName(fullName)) return null;
  try {
    const rows = await fetchCreditRows();
    return outstandingFromBalance(findCreditInSheet(rows, fullName));
  } catch (err) {
    console.error('[sheets] credit lookup failed:', err);
    return null;
  }
}
