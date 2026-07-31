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
// TODO: replace the placeholder amounts (euros) and bank account details with
// the real values. These are non-secret org data; kept as constants so the data
// object and the email stay in sync. (Move to env vars if you'd rather not bake
// them into the bundle.)
const SYMBIOSE_PAUSCHALE = 30;
const OEUV_BEITRAG = 20;

const AMOUNTS = {
  foxes: 150, // Foxes yearly membership (paid to UVie)
  echoUvie: 160, // Echo/Rumble full membership when assigned to UVie
  echoEoefc: 160, // Echo/Rumble full membership when assigned to EÖFC
  // Reduced rates for students (university / high school). The student rate
  // replaces only the main club fee; Symbiosepauschale and ÖBV are unchanged.
  // TODO: confirm the real reduced values.
  foxesStudent: 75,
  echoUvieStudent: 80,
  echoEoefcStudent: 80,
};

export interface BankAccount {
  holder: string;
  iban: string;
  bic: string;
  bank: string;
}

const BANK_ACCOUNTS: Record<Club, BankAccount> = {
  UVie: {
    holder: 'Ultimate Vienna',
    iban: 'TODO IBAN',
    bic: 'TODO BIC',
    bank: 'TODO Bank',
  },
  EÖFC: {
    holder: 'EÖFC',
    iban: 'TODO IBAN',
    bic: 'TODO BIC',
    bank: 'TODO Bank',
  },
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

  if (row.team === 'foxes') {
    const amount = row.student ? AMOUNTS.foxesStudent : AMOUNTS.foxes;
    return {
      team: 'foxes',
      season,
      member,
      assignedClub: 'UVie',
      payments: [
        {
          club: 'UVie',
          amount,
          purpose: `Foxes Mitgliedsbeitrag ${season}${row.student ? ' (ermäßigt)' : ''}`,
          account: BANK_ACCOUNTS.UVie,
        },
      ],
    };
  }

  // echo / rumble
  const club: Club = appendResult.club!;
  const other: Club = club === 'UVie' ? 'EÖFC' : 'UVie';
  const baseAmount = row.student
    ? (club === 'UVie' ? AMOUNTS.echoUvieStudent : AMOUNTS.echoEoefcStudent)
    : (club === 'UVie' ? AMOUNTS.echoUvie : AMOUNTS.echoEoefc);
  let fullAmount = baseAmount;
  if (row.payNationalFee) {
    fullAmount += OEUV_BEITRAG;
  }

  const payments: PaymentItem[] = [
    {
      club,
      amount: fullAmount,
      purpose: `Mitgliedsbeitrag ${club} ${season}${row.student ? ' (ermäßigt)' : ''}`,
      account: BANK_ACCOUNTS[club],
    },
    {
      club: other,
      amount: SYMBIOSE_PAUSCHALE,
      purpose: `Symbiosepauschale ${other} ${season}`,
      account: BANK_ACCOUNTS[other],
    },
  ];

  return {
    team: 'echo',
    season,
    member,
    assignedClub: club,
    payments,
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
