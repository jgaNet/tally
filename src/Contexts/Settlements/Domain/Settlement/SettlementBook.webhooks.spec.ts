import { Id } from '@Architecture/Domain';

import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** A payment through the provider, pending, as the book reads it from the file. */
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
  );

/** The book as it is read: its version, and the group's settlements, the payments waiting among them. */
const bookWaiting = (...settlements: Settlement[]) =>
  SettlementBook.fromSnapshot({ id: 'book', groupId: 'group', version: 1, settlements });

describe('SettlementBook.receivePayment (request 14: webhooks twice, late or out of order)', () => {
  it('moves a payment that succeeded to paid once, and a second "succeeded" for it changes nothing and records no fact', () => {
    const book = bookWaiting(pendingPayment('pay_1'));

    expect(book.receivePayment('pay_1', 'succeeded')).toBe(true);
    expect(book.receivePayment('pay_1', 'succeeded')).toBe(false);

    const events = book.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['SettlementPaidEvent']);
    expect(book.statusChangedSinceRead.map(settlement => settlement.status)).toEqual(['paid']);
  });

  it('keeps a payment that succeeded paid when a pending webhook comes after it, and records no fact for that webhook', () => {
    const settlement = pendingPayment('pay_1');
    const book = bookWaiting(settlement);

    expect(book.receivePayment('pay_1', 'succeeded')).toBe(true);
    expect(book.receivePayment('pay_1', 'pending')).toBe(false);

    expect(settlement.status).toBe('paid');
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);
  });

  it('changes nothing for a status the payment has gone past: a "succeeded" after a "failed", or a "failed" after a "succeeded"', () => {
    const failed = bookWaiting(pendingPayment('pay_1'));
    expect(failed.receivePayment('pay_1', 'failed')).toBe(true);
    expect(failed.receivePayment('pay_1', 'succeeded')).toBe(false);
    expect(failed.pullDomainEvents().map(event => event.name)).toEqual(['SettlementFailedEvent']);

    const paid = bookWaiting(pendingPayment('pay_2'));
    expect(paid.receivePayment('pay_2', 'succeeded')).toBe(true);
    expect(paid.receivePayment('pay_2', 'failed')).toBe(false);
    expect(paid.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);
  });

  it('a payment read after it was decided is not waiting, so a late webhook about it changes nothing', () => {
    // The book read after the payment was paid: the payment is no longer among those waiting.
    const book = SettlementBook.fromSnapshot({ id: 'book', groupId: 'group', version: 2, settlements: [] });

    expect(book.receivePayment('pay_1', 'succeeded')).toBe(false);
    expect(book.receivePayment('pay_1', 'failed')).toBe(false);
    expect(book.statusChangedSinceRead).toEqual([]);
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('a payment Tally does not know, or a status it does not know, changes nothing', () => {
    const settlement = pendingPayment('pay_1');
    const book = bookWaiting(settlement);

    expect(book.receivePayment('pay_unknown', 'succeeded')).toBe(false);
    expect(book.receivePayment('pay_1', 'processing')).toBe(false);

    expect(settlement.status).toBe('pending');
    expect(book.statusChangedSinceRead).toEqual([]);
    expect(book.pullDomainEvents()).toEqual([]);
  });
});
