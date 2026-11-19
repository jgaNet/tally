import { RequestProviderPaymentCommand, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { stillBalance } from '@Contexts/Settlements/Domain/Settlement/StillOwed';

const at = new Date('2026-11-17T10:00:00.000Z');

/** Bob (the payer) pays Ann (the payee) 300 through the provider, Bob owing Ann 300, with both members of the group. */
const request = (overrides: Partial<RequestProviderPaymentCommand> = {}): RequestProviderPaymentCommand => ({
  by: 'bob',
  to: 'ann',
  suspended: false,
  payeeDeleted: false,
  amount: 300,
  members: ['ann', 'bob', 'cy'],
  balances: { payer: -300, payee: 300 },
  payoutAccount: 'ann-at-the-provider',
  at,
  archived: false,
  ...overrides,
});

/** Records the provider settlement of `request()` in the book, with a fee of `fee` as the provider said it. */
function requested(book: SettlementBook, fee: number) {
  const command = request();
  const reserved = book.reserveProviderPayment(command);
  if (reserved.isFailure()) throw reserved.error;
  return book.recordProviderPayment(command, {
    settlementId: reserved.data.settlementId,
    providerPaymentId: 'pay-1',
    payUrl: 'https://pay.example/pay-1',
    fee,
  });
}

/** A book whose owner, Ann, has decided who bears the fee. */
const owned = (borneBy: string) => {
  const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
  const decided = book.setFeePolicy({ by: 'ann', ownerId: 'ann', borneBy, archived: false });
  if (decided.isFailure()) throw decided.error;
  return book;
};

describe('the provider fee of a group (request 38)', () => {
  it('is borne by the payee until its owner decides', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    expect(book.feeBorne).toBe('payee');
    const recorded = requested(book, 31);
    expect(recorded.isSuccess() && recorded.data.fee).toEqual({ amount: 31, borneBy: 'payee' });
    expect(book.pending[0]).toMatchObject({ amount: 300, settled: 300 });
  });

  it('lets only the owner decide who bears it, and refuses another member', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    const refused = book.setFeePolicy({ by: 'bob', ownerId: 'ann', borneBy: 'payer', archived: false });
    expect(refused.isFailure()).toBe(true);
    expect(book.feeBorne).toBe('payee');
    expect(book.feeBorneChanged).toBeUndefined();
  });

  it('refuses a bearer that is not payer, payee or shared, and an archived group', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
    expect(book.setFeePolicy({ by: 'ann', ownerId: 'ann', borneBy: 'both', archived: false }).isFailure()).toBe(true);
    expect(book.setFeePolicy({ by: 'ann', ownerId: 'ann', borneBy: 'payer', archived: true }).isFailure()).toBe(true);
    expect(book.feeBorne).toBe('payee');
  });

  it('settles what the payer bears less the fee: the payer still owes it, in the balances while it waits', () => {
    const book = owned('payer');
    expect(book.feeBorneChanged).toBe('payer');
    const recorded = requested(book, 31);
    expect(recorded.isSuccess() && recorded.data.amount).toBe(300);
    expect(book.pending[0]).toMatchObject({ amount: 300, settled: 269 });
    // The payer owed 300 and is waiting to pay 269 through the provider: 31 is still owed.
    expect(stillBalance(-300, { paid: 269, received: 0 })).toBe(-31);
  });

  it('settles half of the fee each when shared, the payee bearing the extra hundredth', () => {
    const book = owned('shared');
    expect(requested(book, 31).isSuccess()).toBe(true);
    expect(book.pending[0]).toMatchObject({ settled: 285 });
  });

  it('refuses a provider fee that is not less than the payment, or not a whole amount, and keeps nothing', () => {
    for (const fee of [300, 301, -1, 1.5]) {
      const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });
      const recorded = requested(book, fee);
      expect(recorded.isFailure()).toBe(true);
      expect(book.recorded).toEqual([]);
      expect(book.pending).toEqual([]);
    }
  });

  it('keeps the bearer and the fee a settlement was asked with when the owner decides again later', () => {
    const book = owned('payer');
    requested(book, 31);
    const again = SettlementBook.fromSnapshot({
      groupId: 'group-1',
      version: 1,
      pending: book.pending.map(each => ({ ...each })),
      feeBorne: 'payee',
    });
    expect(again.feeBorne).toBe('payee');
    expect(again.pending[0]).toMatchObject({ settled: 269 });
  });
});
