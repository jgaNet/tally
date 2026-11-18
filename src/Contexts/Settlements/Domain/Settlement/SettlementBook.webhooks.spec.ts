import { Id } from '@Architecture/Domain';

import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const LEARNED_AT = new Date('2026-03-10T10:05:00Z');

/** A payment through the provider, pending, as the book reads it from the file, with the history it has. */
const pendingPayment = (paymentId: string): Settlement =>
  new Settlement(
    new Id(`settlement-${paymentId}`),
    new Id('group'),
    new Id('bob'),
    new Id('ann'),
    30,
    'provider',
    'pending',
    new Date('2026-03-10T10:00:00Z'),
    { paymentId, payUrl: `https://pay.example/${paymentId}` },
    [{ status: 'pending', at: new Date('2026-03-10T10:00:00Z') }],
  );

/** The book as it is read: its version, and the group's settlements, the payments waiting among them. */
const bookWaiting = (...settlements: Settlement[]) =>
  SettlementBook.fromSnapshot({ id: 'book', groupId: 'group', version: 1, settlements });

describe('SettlementBook history (request 19: every status a settlement had, when Tally learned it)', () => {
  it('adds the one line of the status a webhook moves a payment to, at the time it was learned, and nothing for a webhook that changes nothing', () => {
    const settlement = pendingPayment('pay_1');
    const book = bookWaiting(settlement);

    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(true);
    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(false);

    expect(settlement.history.map(line => line.status)).toEqual(['pending', 'paid']);
    expect(settlement.history[1].at).toEqual(LEARNED_AT);
    expect(book.learnedSinceRead).toEqual([
      { settlementId: settlement.id, position: 2, status: 'paid', at: LEARNED_AT },
    ]);
  });

  it('adds only the status a refund moves a pending payment to, never the paid it did not have', () => {
    const settlement = pendingPayment('pay_1');
    const book = bookWaiting(settlement);

    expect(book.receivePayment('pay_1', 'refunded', LEARNED_AT)).toBe(true);

    expect(settlement.status).toBe('refunded');
    expect(settlement.history.map(line => line.status)).toEqual(['pending', 'refunded']);
  });

  it('lines a settlement recorded in cash starts with paid, and the book learned it', () => {
    const book = SettlementBook.open(new Id('group'));

    const recorded = book.recordCash({
      archived: false,
      payer: new Id('bob'),
      payee: new Id('ann'),
      amount: 10,
      payerIsMember: true,
      payeeIsMember: true,
      payerBalance: -10,
      payeeBalance: 10,
      now: LEARNED_AT,
    });

    expect(recorded.isSuccess()).toBe(true);
    expect(book.learnedSinceRead).toEqual([
      { settlementId: recorded.data!.id, position: 1, status: 'paid', at: LEARNED_AT },
    ]);
  });
});

describe('SettlementBook.receivePayment (request 14: webhooks twice, late or out of order)', () => {
  it('moves a payment that succeeded to paid once, and a second "succeeded" for it changes nothing and records no fact', () => {
    const book = bookWaiting(pendingPayment('pay_1'));

    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(true);
    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(false);

    const events = book.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['SettlementPaidEvent']);
    expect(book.statusChangedSinceRead.map(settlement => settlement.status)).toEqual(['paid']);
  });

  it('keeps a payment that succeeded paid when a pending webhook comes after it, and records no fact for that webhook', () => {
    const settlement = pendingPayment('pay_1');
    const book = bookWaiting(settlement);

    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(true);
    expect(book.receivePayment('pay_1', 'pending', LEARNED_AT)).toBe(false);

    expect(settlement.status).toBe('paid');
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);
  });

  it('changes nothing for a status the payment has gone past: a "succeeded" after a "failed", or a "failed" after a "succeeded"', () => {
    const failed = bookWaiting(pendingPayment('pay_1'));
    expect(failed.receivePayment('pay_1', 'failed', LEARNED_AT)).toBe(true);
    expect(failed.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(false);
    expect(failed.pullDomainEvents().map(event => event.name)).toEqual(['SettlementFailedEvent']);

    const paid = bookWaiting(pendingPayment('pay_2'));
    expect(paid.receivePayment('pay_2', 'succeeded', LEARNED_AT)).toBe(true);
    expect(paid.receivePayment('pay_2', 'failed', LEARNED_AT)).toBe(false);
    expect(paid.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);
  });

  it('a payment read after it was decided is not waiting, so a late webhook about it changes nothing', () => {
    // The book read after the payment was paid: the payment is no longer among those waiting.
    const book = SettlementBook.fromSnapshot({ id: 'book', groupId: 'group', version: 2, settlements: [] });

    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(false);
    expect(book.receivePayment('pay_1', 'failed', LEARNED_AT)).toBe(false);
    expect(book.statusChangedSinceRead).toEqual([]);
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('a payment Tally does not know, or a status it does not know, changes nothing', () => {
    const settlement = pendingPayment('pay_1');
    const book = bookWaiting(settlement);

    expect(book.receivePayment('pay_unknown', 'succeeded', LEARNED_AT)).toBe(false);
    expect(book.receivePayment('pay_1', 'processing', LEARNED_AT)).toBe(false);

    expect(settlement.status).toBe('pending');
    expect(book.statusChangedSinceRead).toEqual([]);
    expect(book.pullDomainEvents()).toEqual([]);
  });
});

describe('SettlementBook money moved (request 28: the changes of money the audit records)', () => {
  it('moves money when a provider payment succeeds, by its payer, and when a paid one is refunded, by its payee', () => {
    const pending = pendingPayment('pay_1');
    const paid = new Settlement(
      new Id('settlement-pay_2'),
      new Id('group'),
      new Id('bob'),
      new Id('ann'),
      30,
      'provider',
      'paid',
      new Date('2026-03-10T10:00:00Z'),
      { paymentId: 'pay_2', payUrl: 'https://pay.example/pay_2' },
      [
        { status: 'pending', at: new Date('2026-03-10T10:00:00Z') },
        { status: 'paid', at: new Date('2026-03-10T10:01:00Z') },
      ],
    );
    const book = bookWaiting(pending, paid);

    expect(book.receivePayment('pay_1', 'succeeded', LEARNED_AT)).toBe(true);
    expect(book.receivePayment('pay_2', 'refunded', LEARNED_AT)).toBe(true);

    expect(book.moneyMovedSinceRead.map(move => [move.action, move.by.value, move.settlement.id.value])).toEqual([
      ['settlement-paid', 'bob', 'settlement-pay_1'],
      ['settlement-refunded', 'ann', 'settlement-pay_2'],
    ]);
  });

  it('moves no money for a refund of a payment the balances never counted (pending)', () => {
    const book = bookWaiting(pendingPayment('pay_1'));

    expect(book.receivePayment('pay_1', 'refunded', LEARNED_AT)).toBe(true);

    expect(book.moneyMovedSinceRead).toEqual([]);
  });

  it('moves money when a settlement in cash is recorded, by its payee who recorded it', () => {
    const book = SettlementBook.open(new Id('group'));

    const recorded = book.recordCash({
      archived: false,
      payer: new Id('bob'),
      payee: new Id('ann'),
      amount: 10,
      payerIsMember: true,
      payeeIsMember: true,
      payerBalance: -10,
      payeeBalance: 10,
      now: LEARNED_AT,
    });

    expect(recorded.isFailure()).toBe(false);
    expect(book.moneyMovedSinceRead).toEqual([
      { action: 'settlement-paid', by: new Id('ann'), settlement: recorded.data },
    ]);
  });
});
