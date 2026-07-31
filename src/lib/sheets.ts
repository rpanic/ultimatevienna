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
//   A Timestamp | B Team | C FirstName | D LastName | E Email | F BirthDate
//   G Phone | H Address | I OtherClubs | J PayNationalFee | K Status
//
// Team values are "echo" or "foxes". When the env vars are not set, the client
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

type Club = "UVie" | "EÖFC";

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
  'Club',
  'Status',
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
}

export interface AppendResult {
  success: boolean;
  dryRun: boolean;
  club?: Club;
}

/** Append a new member registration as a row, with Status = "pending". */
export async function appendMember(row: MemberRow): Promise<AppendResult> {
  if (!isSheetsConfigured()) {
    console.warn('[sheets] not configured — dry run. Would append row:', row);
    return { success: true, dryRun: true };
  }

  const club: Club = row.team === "foxes" ? "UVie" : await getNextEchoRumbleClub();

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
    club,
    'pending',
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
  return { success: true, dryRun: false, club: club };
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

  const uvie = counts.counts["UVie"];
  const eoefc = counts.counts["EÖFC"];

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
