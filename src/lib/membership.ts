import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import MembershipEmail from '../emails/MembershipEmail.astro';
import type { AppendResult, Club, MemberRow } from './sheets';

// Membership logic split into two functions:
//
//   getInfo(appendResult) -> MembershipInfo
//     Gathers everything needed to represent a member's registration and their
//     payment obligations as a plain JS object. `appendResult` (returned by
//     appendMember) carries the submitted row + the assigned club. The same
//     object drives the printable email AND will be reused by the frontend to
//     display the same information, so it stays JSON-serializable.
//
//   renderMembershipEmail(info) -> string (full HTML document)
//     Renders the email by delegating to the Astro component at
//     src/emails/MembershipEmail.astro, using Astro's Container API
//     (astro:render / astro:container) to turn the component into an HTML string
//     server-side.
//
// Payment rules. A member is on a team (Foxes or Echo/Rumble) and may be a
// student (university / high school), which reduces the main club membership
// fee only — the 30 € Symbiosepauschale and the optional 20 € ÖBV national fee
// are unaffected.
//   - Foxes:                       one payment to UVie for the Foxes amount.
//   - Echo/Rumble, assigned UVie:  UVie amount to UVie + 30 € Symbiosepauschale to EÖFC.
//   - Echo/Rumble, assigned EÖFC:  EÖFC amount to EÖFC + 30 € Symbiosepauschale to UVie.
// Each amount has a reduced student variant.

// --- Configuration ----------------------------------------------------------
// TODO: replace the placeholder amounts (euros) with the real values. Bank
// account details are read from env vars (UVIE_BANK_* / EOFC_BANK_*) below —
// see .env.example. They fall back to the placeholders so the site stays
// demoable without the env set.
const SYMBIOSE_PAUSCHALE = 30;
const OEUV_BEITRAG = 20;

const AMOUNTS = {
  foxes: 150, // Foxes yearly membership (paid to UVie)
  echoUvie: 190, // Echo/Rumble full membership when assigned to UVie
  echoEoefc: 190, // Echo/Rumble full membership when assigned to EÖFC
  // Reduced rates for students (university / high school). The student rate
  // replaces only the main club fee; Symbiosepauschale and ÖBV are unchanged.
  // TODO: confirm the real reduced values.
  echoUvieStudent: 130,
  echoEoefcStudent: 130,
};

export interface BankAccount {
  holder: string;
  iban: string;
  bic: string;
}

// Read a server-side env var from import.meta.env (Vite dev / build) then
// process.env (Node adapter in production). Bank details are non-secret org
// data, but keeping them server-side means they never end up in the client
// bundle — the email and result page are both server-rendered.
function env(name: string): string | undefined {
  const fromImport = (import.meta.env as Record<string, string | undefined>)[name];
  if (fromImport) return fromImport;
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  return undefined;
}

// Bank accounts per club, read from env (UVIE_BANK_* / EOFC_BANK_*). Falls back
// to the placeholders so the site stays demoable without the env set.
const bankAccount = (prefix: string, fallback: BankAccount): BankAccount => ({
  holder: env(`${prefix}_HOLDER`) ?? fallback.holder,
  iban: env(`${prefix}_IBAN`) ?? fallback.iban,
  bic: env(`${prefix}_BIC`) ?? fallback.bic,
});

const BANK_ACCOUNTS: Record<Club, BankAccount> = {
  UVie: bankAccount('UVIE_BANK', {
    holder: 'Ultimate Vienna',
    iban: 'TODO IBAN',
    bic: 'TODO BIC',
  }),
  EÖFC: bankAccount('EOFC_BANK', {
    holder: 'EÖFC',
    iban: 'TODO IBAN',
    bic: 'TODO BIC',
  }),
};
// --------------------------------------------------------------------------

export interface PaymentItem {
  /** Which club receives this payment. */
  club: Club;
  /** Amount in whole euros. */
  amount: number;
  /** Human-readable label, e.g. "Mitgliedsbeitrag UVie 2026". */
  purpose: string;
  /** Bank account this payment goes to. */
  account: BankAccount;
}

export interface MembershipInfo {
  team: 'echo' | 'foxes';
  /** Membership year/season, e.g. "2026". */
  season: string;
  member: {
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
  };
  /** The club the member was assigned to (echo/rumble only; foxes -> UVie). */
  assignedClub?: Club;
  /** One (foxes) or two (echo/rumble) payments. */
  payments: PaymentItem[];
}

function currentSeason(): string {
  return String(new Date().getFullYear());
}

export interface PaymentInput {
  team: 'echo' | 'foxes';
  /** The club the member is assigned to (foxes is always UVie). */
  assignedClub: Club;
  /** University / high school student — reduces the main club fee (echo only). */
  student: boolean;
  /** Whether UVie should pay the ÖBV national fee on the member's behalf. */
  payNationalFee: boolean;
  /** Membership year/season, e.g. "2026". */
  season: string;
}

/**
 * Compute the payment items a member owes. Pure (no I/O) so it can be reused
 * anywhere — by getMembershipInfo after the sheet append, and directly by the
 * frontend to preview amounts without round-tripping through the sheet.
 *
 *   - Foxes:                       one payment to UVie (Foxes amount + optional ÖBV).
 *   - Echo/Rumble, assigned UVie:  UVie amount to UVie + 30 € Symbiosepauschale to EÖFC.
 *   - Echo/Rumble, assigned EÖFC:   EÖFC amount to EÖFC + 30 € Symbiosepauschale to UVie.
 *
 * The student rate replaces only the main club fee; the Symbiosepauschale and
 * the optional ÖBV fee are unaffected. Foxes has no student rate.
 */
export function buildPayments(input: PaymentInput): PaymentItem[] {
  const oeuvAmount = input.payNationalFee ? OEUV_BEITRAG : 0;

  if (input.team === 'foxes') {
    return [
      {
        club: 'UVie',
        amount: AMOUNTS.foxes + oeuvAmount,
        purpose: `Foxes Mitgliedsbeitrag ${input.season}`,
        account: BANK_ACCOUNTS.UVie,
      },
    ];
  }

  // echo / rumble
  const club = input.assignedClub;
  const other: Club = club === 'UVie' ? 'EÖFC' : 'UVie';
  const baseAmount = input.student
    ? (club === 'UVie' ? AMOUNTS.echoUvieStudent : AMOUNTS.echoEoefcStudent)
    : (club === 'UVie' ? AMOUNTS.echoUvie : AMOUNTS.echoEoefc);

  return [
    {
      club,
      amount: baseAmount + oeuvAmount,
      purpose: `Mitgliedsbeitrag ${club} ${input.season}${input.student ? ' (ermäßigt)' : ''}`,
      account: BANK_ACCOUNTS[club],
    },
    {
      club: other,
      amount: SYMBIOSE_PAUSCHALE,
      purpose: `Symbiosepauschale ${other} ${input.season}`,
      account: BANK_ACCOUNTS[other],
    },
  ];
}

/**
 * Build the membership data object from an append result. The assigned club
 * comes from `appendResult.club`; if it's missing (e.g. a dry-run append that
 * didn't call getNextEchoRumbleClub), the Echo tab is tallied to pick one, so
 * the object is always complete.
 */
export async function getMembershipInfo(appendResult: AppendResult): Promise<MembershipInfo> {
  const row: MemberRow | undefined = appendResult.row;
  if (!row) {
    throw new Error(
      'getInfo: appendResult.row is missing — appendMember must carry the submitted row.',
    );
  }

  const member = {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    birthDate: row.birthDate,
    phone: row.phone,
    address: row.address,
    otherClubs: row.otherClubs,
    payNationalFee: row.payNationalFee,
    student: row.student,
  };
  const season = currentSeason();

  // Foxes is always assigned to UVie; echo/rumble gets the club chosen during
  // the sheet append (appendResult.club). All amount/purpose logic lives in
  // buildPayments so it can be reused without the sheet round-trip.
  const assignedClub: Club = row.team === 'foxes' ? 'UVie' : appendResult.club!;

  return {
    team: row.team,
    season,
    member,
    assignedClub,
    payments: buildPayments({
      team: row.team,
      assignedClub,
      student: row.student,
      payNationalFee: row.payNationalFee,
      season,
    }),
  };
}

// Re-use one Container instance across renders.
let cachedContainer: Awaited<ReturnType<typeof AstroContainer.create>> | null = null;
async function getContainer() {
  if (!cachedContainer) cachedContainer = await AstroContainer.create();
  return cachedContainer;
}

/**
 * Render the printable membership email as a full HTML document string, using
 * Astro's Container API to render MembershipEmail.astro server-side.
 */
export async function renderMembershipEmail(info: MembershipInfo): Promise<string> {
  const container = await getContainer();
  return container.renderToString(MembershipEmail, { props: { info } });
}
