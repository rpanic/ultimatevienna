import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import MembershipEmail from '../emails/MembershipEmail.astro';
import { getDebtItems, getOutstandingCredit, type AppendResult, type Club, type DebtItem, type MemberRow } from './sheets';

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
// fee only — the 35 € Symbiosepauschale and the optional 20 € ÖBV national fee
// are unaffected.
//   - Foxes:                       one payment to UVie for the Foxes amount.
//   - Echo/Rumble, assigned UVie:  UVie amount to UVie + 35 € Symbiosepauschale to EÖFC.
//   - Echo/Rumble, assigned EÖFC:  EÖFC amount to EÖFC + 35 € Symbiosepauschale to UVie.
// Each amount has a reduced student variant.

// --- Configuration ----------------------------------------------------------
// TODO: replace the placeholder amounts (euros) with the real values. Bank
// account details are read from env vars (UVIE_BANK_* / EOFC_BANK_*) below —
// see .env.example. They fall back to the placeholders so the site stays
// demoable without the env set.
const SYMBIOSE_PAUSCHALE = 35;
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

export interface PaymentLineItem {
  /** Amount in whole euros for this component of the payment. */
  amount: number;
  /** What this portion covers, e.g. "Mitgliedsbeitrag UVie 2026" or "ÖUV-Spielermeldung 2026". */
  description: string;
}

export interface PaymentItem {
  /** Which club receives this payment. */
  club: Club;
  /** Total amount to transfer — the sum of `items`. */
  amount: number;
  /** Headline label / recommended Verwendungszweck, e.g. "Mitgliedsbeitrag UVie 2026". */
  purpose: string;
  /** Bank account this payment goes to. */
  account: BankAccount;
  /** The components that sum to `amount`, shown as a breakdown when there's more than one. */
  items: PaymentLineItem[];
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
    /** Club the member says they already paid this season's membership fee to
     * ('none' if not). The matching club's payment is dropped from the summary. */
    alreadyPaidClub: 'none' | Club;
    /** Echo/rumble only: the member already paid the Symbiosepauschale to the
     * other club too, so that payment is also dropped. Always false for foxes. */
    alreadyPaidSymbiose: boolean;
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
 *   - Echo/Rumble, assigned UVie:  UVie amount to UVie + 35 € Symbiosepauschale to EÖFC.
 *   - Echo/Rumble, assigned EÖFC:   EÖFC amount to EÖFC + 35 € Symbiosepauschale to UVie.
 *
 * The student rate replaces only the main club fee; the Symbiosepauschale and
 * the optional ÖBV fee are unaffected. Foxes has no student rate.
 */
export function buildPayments(input: PaymentInput): PaymentItem[] {
  const season = input.season;
  const erm = input.student ? ' (ermäßigt)' : '';
  // The ÖUV national fee is reimbursed to the assigned club in the SAME transfer
  // as the main membership fee, so it appears as a line item on the main payment.
  const nationalFeeItem: PaymentLineItem = {
    amount: OEUV_BEITRAG,
    description: `ÖUV-Spielermeldung ${season}`,
  };
  const total = (items: PaymentLineItem[]) => items.reduce((sum, i) => sum + i.amount, 0);

  if (input.team === 'foxes') {
    const items: PaymentLineItem[] = [
      { amount: AMOUNTS.foxes, description: `Foxes Mitgliedsbeitrag ${season}` },
    ];
    if (input.payNationalFee) items.push(nationalFeeItem);
    return [
      {
        club: 'UVie',
        amount: total(items),
        purpose: `Foxes Mitgliedsbeitrag ${season}`,
        account: BANK_ACCOUNTS.UVie,
        items,
      },
    ];
  }

  // echo / rumble
  const club = input.assignedClub;
  const other: Club = club === 'UVie' ? 'EÖFC' : 'UVie';
  const baseAmount = input.student
    ? (club === 'UVie' ? AMOUNTS.echoUvieStudent : AMOUNTS.echoEoefcStudent)
    : (club === 'UVie' ? AMOUNTS.echoUvie : AMOUNTS.echoEoefc);

  const mainItems: PaymentLineItem[] = [
    { amount: baseAmount, description: `Mitgliedsbeitrag ${club} ${season}${erm}` },
  ];
  if (input.payNationalFee) mainItems.push(nationalFeeItem);

  const symbioseItems: PaymentLineItem[] = [
    { amount: SYMBIOSE_PAUSCHALE, description: `Symbiosepauschale ${other} ${season}` },
  ];

  return [
    {
      club,
      amount: total(mainItems),
      purpose: `Mitgliedsbeitrag ${club} ${season}${erm}`,
      account: BANK_ACCOUNTS[club],
      items: mainItems,
    },
    {
      club: other,
      amount: total(symbioseItems),
      purpose: `Symbiosepauschale ${other} ${season}`,
      account: BANK_ACCOUNTS[other],
      items: symbioseItems,
    },
  ];
}

/**
 * Build the membership data object from an append result. The assigned club
 * comes from `appendResult.club`; if it's missing (e.g. a dry-run append that
 * didn't call getNextEchoRumbleClub), the Echo tab is tallied to pick one, so
 * the object is always complete.
 */
/**
 * Whether a payment line item should be dropped because it is already on the
 * member's UVie debt (so we don't invoice it twice). Only UVie-side items:
 *   - the UVie membership fee — the reduced (student) variant is detected by
 *     the "(ermäßigt)" marker in the description, matched against the
 *     reducedMembership marker, otherwise the fullMembership marker;
 *   - the Symbiosepauschale, but ONLY when it is the one owed to UVie
 *     (item.club === 'UVie', i.e. the member is assigned to EÖFC — the
 *     symbiose goes to the non-assigned club);
 *   - the ÖUV national federation fee, but ONLY when it is owed to UVie
 *     (item.club === 'UVie', i.e. foxes or echo assigned to UVie — the fee is
 *     paid to the assigned club, so it is on UVie's debt sheet only then).
 * Item kind is detected from the description prefix set in buildPayments, so
 * the Foxes fee ("Foxes Mitgliedsbeitrag …"), the EÖFC membership, the
 * EÖFC-bound symbiose, and the EÖFC-bound ÖUV fee are never matched (not
 * tracked in the UVie debt sheet).
 */
function isDebtInvoiced(item: PaymentLineItem, club: Club, debtItems: Set<DebtItem>): boolean {
  const desc = item.description.toLowerCase();
  if (desc.startsWith('mitgliedsbeitrag') && club === 'UVie') {
    return desc.includes('ermäßigt')
      ? debtItems.has('reducedMembership')
      : debtItems.has('fullMembership');
  }
  if (desc.startsWith('symbiosepauschale') && club === 'UVie') {
    return debtItems.has('symbiosepauschale');
  }
  if (desc.startsWith('öuv-spielermeldung') && club === 'UVie') {
    return debtItems.has('nationalFee');
  }
  return false;
}

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
    alreadyPaidClub: row.alreadyPaidClub,
    alreadyPaidSymbiose: row.alreadyPaidSymbiose,
  };
  const season = currentSeason();

  // Foxes is always assigned to UVie; echo/rumble gets the club chosen during
  // the sheet append (appendResult.club). All amount/purpose logic lives in
  // buildPayments so it can be reused without the sheet round-trip.
  const assignedClub: Club = row.team === 'foxes' ? 'UVie' : appendResult.club!;

  let payments = buildPayments({
    team: row.team,
    assignedClub,
    student: row.student,
    payNationalFee: row.payNationalFee,
    season,
  });

  // If the member already paid a club's membership fee this season, drop that
  // club's fee items (we can't verify, so we don't double-charge). Clear the
  // items but keep the card for now — the outstanding UVie debt (added next) is
  // NOT the membership fee and must still be collected, so the UVie card may
  // survive with only the debt. Empty cards are dropped after.
  const alreadyPaid = row.alreadyPaidClub;
  if (alreadyPaid !== 'none') {
    payments = payments.map((p) =>
      p.club === alreadyPaid ? { ...p, items: [], amount: 0 } : p,
    );
  }

  // Echo/rumble only: if the member already paid the Symbiosepauschale to the
  // OTHER club too, drop that card. The Symbiosepauschale is always paid to the
  // non-assigned club, so we clear that club's card (same clear-but-keep-then-
  // drop-below pattern). The outstanding UVie debt added next is separate and
  // still collected. Foxes never set this (no Symbiosepauschale).
  if (row.alreadyPaidSymbiose && row.team !== 'foxes') {
    const other: Club = assignedClub === 'UVie' ? 'EÖFC' : 'UVie';
    payments = payments.map((p) =>
      p.club === other ? { ...p, items: [], amount: 0 } : p,
    );
  }

  // UVie debt-sheet "already invoiced" markers: the credit/debt sheet marks,
  // per member, when their UVie full/reduced membership or Symbiosepauschale
  // has already been added to their UVie debt — so we must not invoice it
  // again. Drop just the matching line items (keep the card; empty cards are
  // dropped below). Only UVie-side items are tracked: the UVie membership fee
  // (full or reduced by student status) and the Symbiosepauschale only when
  // it's the one owed to UVie (member assigned to EÖFC). The outstanding UVie
  // debt added next is a separate prior amount and is never dropped here.
  // No-op when the feature is off (no row-label env vars) — getDebtItems
  // returns an empty set.
  const debtItems = await getDebtItems(`${row.firstName} ${row.lastName}`);
  if (debtItems.size > 0) {
    payments = payments.map((p) => {
      const items = p.items.filter((it) => !isDebtInvoiced(it, p.club, debtItems));
      if (items.length === p.items.length) return p;
      return { ...p, items, amount: items.reduce((s, i) => s + i.amount, 0) };
    });
  }

  // Add any outstanding UVie debt (from the separate credit sheet) as a line
  // item on the UVie payment, so the member pays it in the same transfer. The
  // debt is a prior unpaid amount, separate from this season's membership fee,
  // so it's added even when the member "already paid UVie" (the UVie card was
  // cleared above but still exists). getOutstandingCredit returns a positive
  // amount only when the member owes; 0/null means no debt or feature off.
  const credit = await getOutstandingCredit(`${row.firstName} ${row.lastName}`);
  if (credit && credit > 0) {
    const uvie = payments.find((p) => p.club === 'UVie');
    const paymentLine = { amount: credit, description: 'Offener Betrag Guthaben' }
    if (uvie) {
      uvie.items = [...uvie.items, paymentLine];
      uvie.amount += credit;
    }
  }

  // Drop cards left with no items (the already-paid club with no outstanding
  // debt) so that club's payment isn't shown at all.
  payments = payments.filter((p) => p.items.length > 0);

  return {
    team: row.team,
    season,
    member,
    assignedClub,
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
