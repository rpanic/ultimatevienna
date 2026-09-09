import { describe, it, expect } from 'vitest';
import { findCreditInSheet, outstandingFromBalance } from './sheets';

// Tests for the credit-reading core (findCreditInSheet), the pure, API-free
// part of getOutstandingCredit. The credit sheet is TRANSPOSED: row 1 (header)
// holds one member name per column (with team/section labels interspersed),
// column A holds row labels, and the "Guthabenstand" row holds each member's
// signed balance. findCreditInSheet matches the member's name against the
// header to find their column, then reads the "Guthabenstand" row.
//
// Header layout used by the fixtures (mirrors the real sheet):
//   A "Guthaben" | B "Echo" | C "Max Mustermann" | D "Anna Anders"
//   | E "Rumble" | F "Köstler Julius"
// and the "Guthabenstand" row holds the balances in those member columns.

const HEADER = [
  'Guthaben',
  'Echo',
  'Max Mustermann',
  'Anna Anders',
  'Rumble',
  'Köstler Julius',
];

// Build a sheet: header + a "Guthabenstand" row whose member columns hold the
// given balances (in header order; pass undefined to leave a cell empty).
function sheet(balances: (string | undefined)[]): string[][] {
  const row: string[] = ['Guthabenstand', '', '', '', '', ''];
  for (let i = 0; i < balances.length; i++) {
    if (balances[i] !== undefined) row[2 + i] = balances[i] as string;
  }
  return [HEADER, row, ['Einzahlungen Stand …', '', '100,00', '0', '', '2.000,00']];
}

describe('findCreditInSheet — column matching', () => {
  it('reads the balance for a member found in the header', () => {
    expect(findCreditInSheet(sheet(['50,00', '-10,00', '7,50']), 'Max Mustermann')).toBe(50);
  });

  it('matches case-insensitively', () => {
    expect(findCreditInSheet(sheet(['50,00']), 'MAX MUSTERMANN')).toBe(50);
    expect(findCreditInSheet(sheet(['50,00']), 'max mustermann')).toBe(50);
  });

  it('matches order-independently (header "Köstler Julius" vs "Julius Köstler")', () => {
    expect(findCreditInSheet(sheet([undefined, undefined, undefined, '1.234,56']), 'Julius Köstler')).toBeCloseTo(1234.56);
  });

  it('matches the "Last, First" comma form against a "First Last" lookup', () => {
    const header = ['Guthaben', 'Echo', 'Mustermann, Max'];
    const rows = [header, ['Guthabenstand', '', '9,90']];
    expect(findCreditInSheet(rows, 'Max Mustermann')).toBeCloseTo(9.9);
  });

  it('does not match a team/section label column ("Echo", "Rumble")', () => {
    // "Echo" is a header label, not a member; even if looked up, its balance
    // cell is empty → null.
    expect(findCreditInSheet(sheet(['50,00']), 'Echo')).toBeNull();
    expect(findCreditInSheet(sheet(['50,00']), 'Rumble')).toBeNull();
  });

  it('returns null when the name is not in the header', () => {
    expect(findCreditInSheet(sheet(['50,00']), 'Someone Else')).toBeNull();
  });

  it('returns null for an empty or whitespace-only full name', () => {
    expect(findCreditInSheet(sheet(['50,00']), '')).toBeNull();
    expect(findCreditInSheet(sheet(['50,00']), '   ')).toBeNull();
  });

  it('returns null for an empty sheet', () => {
    expect(findCreditInSheet([], 'Max Mustermann')).toBeNull();
  });

  it('uses the first matching column when a name appears twice in the header', () => {
    const header = ['Guthaben', 'Echo', 'Max Mustermann', 'Max Mustermann'];
    const rows = [header, ['Guthabenstand', '', '11', '22']];
    expect(findCreditInSheet(rows, 'Max Mustermann')).toBe(11);
  });
});

describe('findCreditInSheet — balance row', () => {
  it('returns null when there is no "Guthabenstand" row', () => {
    const rows = [HEADER, ['Einzahlungen Stand …', '', '50,00']];
    expect(findCreditInSheet(rows, 'Max Mustermann')).toBeNull();
  });

  it('finds the balance row by label, not by position', () => {
    // "Guthabenstand" is the 3rd data row here, not row 2.
    const rows = [
      HEADER,
      ['Einzahlungen Stand …', '', '100,00'],
      ['Sonstiges', '', ''],
      ['Guthabenstand', '', '42,00'],
    ];
    expect(findCreditInSheet(rows, 'Max Mustermann')).toBe(42);
  });

  it('matches the "Guthabenstand" label case-insensitively', () => {
    const rows = [HEADER, ['guthabenSTAND', '', '15']];
    expect(findCreditInSheet(rows, 'Max Mustermann')).toBe(15);
  });
});

describe('findCreditInSheet — amount parsing', () => {
  it('parses a plain integer', () => {
    expect(findCreditInSheet(sheet(['50']), 'Max Mustermann')).toBe(50);
  });

  it('parses a German decimal comma (50,00)', () => {
    expect(findCreditInSheet(sheet(['50,00']), 'Max Mustermann')).toBe(50);
  });

  it('parses thousands dot + decimal comma (1.234,56)', () => {
    expect(findCreditInSheet(sheet(['1.234,56']), 'Max Mustermann')).toBeCloseTo(1234.56);
  });

  it('strips a currency prefix/suffix', () => {
    expect(findCreditInSheet(sheet(['€ 50,00']), 'Max Mustermann')).toBe(50);
    expect(findCreditInSheet(sheet(['50,00 €']), 'Max Mustermann')).toBe(50);
  });

  it('parses a negative balance (member owes)', () => {
    expect(findCreditInSheet(sheet(['-10,00']), 'Max Mustermann')).toBe(-10);
  });

  it('parses zero', () => {
    expect(findCreditInSheet(sheet(['0']), 'Max Mustermann')).toBe(0);
  });

  it('returns null when the balance cell is empty', () => {
    expect(findCreditInSheet(sheet([undefined]), 'Max Mustermann')).toBeNull();
  });

  it('returns null when the balance cell is non-numeric (a formula error)', () => {
    expect(findCreditInSheet(sheet(['#REF!']), 'Max Mustermann')).toBeNull();
    expect(findCreditInSheet(sheet(['abc']), 'Max Mustermann')).toBeNull();
  });
});

describe('outstandingFromBalance — debts only', () => {
  it('returns the positive debt for a negative balance (member owes)', () => {
    expect(outstandingFromBalance(-10)).toBe(10);
    expect(outstandingFromBalance(-677.16)).toBeCloseTo(677.16);
    expect(outstandingFromBalance(-0.5)).toBeCloseTo(0.5);
  });

  it('returns null for a positive balance (UVie owes the member — credit)', () => {
    expect(outstandingFromBalance(50)).toBe(0);
    expect(outstandingFromBalance(0.01)).toBe(0);
  });

  it('returns null for a zero balance (paid up)', () => {
    expect(outstandingFromBalance(0)).toBe(0);
  });

  it('returns null when there is no balance at all', () => {
    expect(outstandingFromBalance(null)).toBe(0);
  });
});
