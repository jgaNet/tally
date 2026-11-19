import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { NetDebts, SharedGroupDebts } from '@Contexts/Settlements/Domain/Netting/NetDebts';

const at = new Date('2026-11-17T10:00:00.000Z');

/** A group of Ann, Bob and Cy, its book at version 0, and the balances as Ledger counts them. */
const group = (
  groupId: string,
  balances: Record<string, number>,
  overrides: Partial<Pick<SharedGroupDebts, 'currency' | 'archived' | 'book'>> = {},
): SharedGroupDebts => ({
  groupId,
  book: overrides.book ?? SettlementBook.fromSnapshot({ groupId, version: 0 }),
  currency: overrides.currency ?? 'EUR',
  archived: overrides.archived ?? false,
  members: ['ann', 'bob', 'cy'],
  balances: Object.entries(balances).map(([memberId, balance]) => ({ memberId, balance })),
});

const netting = (groups: SharedGroupDebts[], overrides: { by?: string; with?: string; currency?: string } = {}) =>
  NetDebts.decide({
    by: overrides.by ?? 'ann',
    with: overrides.with ?? 'bob',
    currency: overrides.currency ?? 'EUR',
    suspended: false,
    withDeleted: false,
    groups,
    at,
  });

/** The netting made, which the test expects to be made. */
const madeOf = (decided: ReturnType<typeof netting>) => {
  if (decided.isFailure()) throw new Error(`the netting was refused: ${decided.error.type}`);
  return decided.data;
};

/** The name of the rule that refused the netting, which the test expects to refuse it. */
const refusedBy = (decided: ReturnType<typeof netting>): string => {
  if (!decided.isFailure()) throw new Error('the netting was made, and a refusal was expected');
  return decided.error.type;
};

describe('a netting between two members', () => {
  it('nets the example of request 32: Ann pays Bob 300 and 100, Bob pays Ann 400', () => {
    const flat = group('flat', { ann: -300, bob: 300 });
    const trip = group('trip', { ann: -200, bob: 200 });
    const club = group('club', { bob: -400, ann: 400 });

    const made = madeOf(netting([flat, trip, club]));

    expect(made.amount).toBe(400);
    const settled = [flat, trip, club].flatMap(each => [...each.book.recorded]);
    expect(
      settled.map(({ groupId, from, to, amount, method, status }) => ({ groupId, from, to, amount, method, status })),
    ).toEqual([
      { groupId: 'flat', from: 'ann', to: 'bob', amount: 300, method: 'net', status: 'paid' },
      { groupId: 'trip', from: 'ann', to: 'bob', amount: 100, method: 'net', status: 'paid' },
      { groupId: 'club', from: 'bob', to: 'ann', amount: 400, method: 'net', status: 'paid' },
    ]);
    expect(made.settlements).toEqual(settled.map(each => each.id));
  });

  it('nets the smaller of the two totals, and what the smaller side can pay in each group', () => {
    const flat = group('flat', { ann: -100, bob: 100 });
    const club = group('club', { bob: -250, ann: 250 });

    const made = madeOf(netting([flat, club]));
    expect(made.amount).toBe(100);
    expect(flat.book.recorded.map(each => [each.from, each.amount])).toEqual([['ann', 100]]);
    expect(club.book.recorded.map(each => [each.from, each.amount])).toEqual([['bob', 100]]);
  });

  it('is refused by NothingToNet when only one of them owes the other, and nothing is recorded', () => {
    // Ann owes Bob 100 in the flat, and Bob owes Ann nothing anywhere: there is nothing to net the other way.
    const flat = group('flat', { ann: -100, bob: 100 });
    const trip = group('trip', { ann: 0, bob: 0 });

    expect(refusedBy(netting([flat, trip]))).toBe('NothingToNet');
    expect(refusedBy(netting([]))).toBe('NothingToNet');
    expect(flat.book.recorded).toEqual([]);
    expect(trip.book.recorded).toEqual([]);
  });

  it('refuses a netting with oneself, and a currency that is not one of Tally', () => {
    const flat = group('flat', { ann: -100, bob: 100 });
    expect(refusedBy(netting([flat], { with: 'ann' }))).toBe('NettingWithSelf');
    expect(refusedBy(netting([flat], { currency: 'XXX' }))).toBe('UnsupportedNettingCurrency');
    expect(flat.book.recorded).toEqual([]);
  });

  it('leaves out the groups in another currency, and the archived ones', () => {
    const usd = group('usd', { ann: -100, bob: 100 }, { currency: 'USD' });
    const archived = group('old', { ann: -100, bob: 100 }, { archived: true });
    const flat = group('flat', { ann: -40, bob: 40 });
    const club = group('club', { bob: -40, ann: 40 });

    const made = madeOf(netting([usd, archived, flat, club]));
    expect(made.amount).toBe(40);
    expect(usd.book.recorded).toEqual([]);
    expect(archived.book.recorded).toEqual([]);
  });

  it('counts a payment waiting at the provider as paid, so it is not netted twice', () => {
    // Ann owes Bob 100 in the flat, and is waiting to pay 100 of it through the provider (pending): nothing is left to net there.
    const book = SettlementBook.fromSnapshot({
      groupId: 'flat',
      version: 1,
      pending: [{ id: 's-1', from: 'ann', to: 'bob', amount: 100, providerPaymentId: 'p-1' }],
    });
    const flat = group('flat', { ann: -100, bob: 100 }, { book });
    const club = group('club', { bob: -100, ann: 100 });

    expect(refusedBy(netting([flat, club]))).toBe('NothingToNet');
  });
});
