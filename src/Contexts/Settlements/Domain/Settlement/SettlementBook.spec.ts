import { ISettlementSnapshot } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const AT = new Date('2026-11-17T10:00:00.000Z');
const ANN = 'ann';
const BOB = 'bob';
const CY = 'cy';
const MEMBERS = [ANN, BOB, CY];

/** Bob owes Ann 30, and Cy is owed nothing: Ann +30, Bob -30, Cy 0. */
const BALANCES = [
  { memberId: ANN, balance: 30 },
  { memberId: BOB, balance: -30 },
  { memberId: CY, balance: 0 },
];

const recordCash = (book: SettlementBook, overrides: Partial<Parameters<SettlementBook['recordCash']>[0]> = {}) =>
  book.recordCash({ payer: BOB, payee: ANN, amount: 30, at: AT, members: MEMBERS, balances: BALANCES, ...overrides });

describe('SettlementBook', () => {
  it('opens at version 0 with an identity of its own, recording nothing', () => {
    const book = SettlementBook.open('group-1');
    expect(book.version).toBe(0);
    expect(book._id.value).toBeTruthy();
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('records a settlement the payer owes, and the event SettlementRecorded with it', () => {
    const book = SettlementBook.open('group-1');
    const recorded = recordCash(book);

    expect(recorded.isSuccess()).toBe(true);
    expect(recorded.isSuccess() && recorded.data).toEqual({
      _id: expect.any(String),
      groupId: 'group-1',
      from: BOB,
      to: ANN,
      amount: 30,
      at: '2026-11-17T10:00:00.000Z',
      method: 'cash',
      status: 'paid',
      providerPaymentId: null,
      payUrl: null,
    });
    const events = book.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('SettlementRecordedEvent');
  });

  it('refuses an amount that is not a whole number of at least 1, recording nothing', () => {
    for (const amount of [0, -5, 1.5]) {
      const book = SettlementBook.open('group-1');
      const refused = recordCash(book, { amount });
      expect(refused.isFailure() && refused.error.type).toBe('InvalidSettlementAmount');
      expect(book.pullDomainEvents()).toEqual([]);
      expect(book.toSnapshot().recorded).toEqual([]);
    }
  });

  it('refuses a settlement of a member with themselves', () => {
    const refused = recordCash(SettlementBook.open('group-1'), { payer: ANN, payee: ANN });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementToSelf');
  });

  it('refuses a payer who is not a member of the group', () => {
    const refused = recordCash(SettlementBook.open('group-1'), { payer: 'stranger' });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementPayerNotMember');
  });

  it('refuses more than the payer owes, and more than the payee is owed', () => {
    const overPayer = recordCash(SettlementBook.open('group-1'), { amount: 31 });
    expect(overPayer.isFailure() && overPayer.error.type).toBe('SettlementExceedsBalance');

    // Ann is owed 30 and Bob pays Cy 1: Bob owes 30, but Cy is owed nothing, so nothing may be paid to Cy.
    const toNobody = recordCash(SettlementBook.open('group-1'), { payee: CY, amount: 1 });
    expect(toNobody.isFailure() && toNobody.error.type).toBe('SettlementExceedsBalance');
  });

  it('decides a settlement against the balances it is given: a payer who owes nothing pays nothing', () => {
    const refused = recordCash(SettlementBook.open('group-1'), {
      balances: [
        { memberId: ANN, balance: 0 },
        { memberId: BOB, balance: 0 },
      ],
    });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementExceedsBalance');
  });

  it('rebuilds from a snapshot at the version it was read at, recording nothing', () => {
    const book = SettlementBook.fromSnapshot({ _id: 'book-1', groupId: 'group-1', version: 4, settlements: [] });
    expect(book.version).toBe(4);
    expect(book._id.value).toBe('book-1');
    expect(book.pullDomainEvents()).toEqual([]);
  });
});

const PAYMENT_LINK = { id: 'pay_1', payUrl: 'https://provider.example/pay/pay_1' };
const PAYEE_ACCOUNT = 'acct_ann';
const proposePayment = (
  book: SettlementBook,
  overrides: Partial<Parameters<SettlementBook['proposePayment']>[0]> = {},
  payeeAccount: string | null = PAYEE_ACCOUNT,
) =>
  book.proposePayment(
    {
      payer: BOB,
      payee: ANN,
      amount: 30,
      at: AT,
      members: MEMBERS,
      balances: BALANCES,
      ...overrides,
    },
    payeeAccount,
  );

/** A book that holds one payment through the provider from Bob to Ann of 30, waiting. */
function bookWithPendingPayment(): { book: SettlementBook; settlementId: string } {
  const book = SettlementBook.open('group-1');
  const proposal = proposePayment(book);
  if (proposal.isFailure()) throw new Error('the proposal should be decided');
  const kept = book.keepPayment(proposal.data, PAYMENT_LINK);
  if (kept.isFailure()) throw new Error('the payment should be kept');
  return { book, settlementId: kept.data._id };
}

/** Rebuilds the book from its snapshot, as the store does when a later writer reads it. */
function reread(book: SettlementBook, settlements: ISettlementSnapshot[]): SettlementBook {
  const snapshot = book.toSnapshot();
  return SettlementBook.fromSnapshot({ _id: snapshot._id, groupId: snapshot.groupId, version: 1, settlements });
}

describe('SettlementBook, a payment through the provider (request 13)', () => {
  it('asks for a payment the rules allow, and keeps it pending with the provider link, recording PaymentRequested', () => {
    const book = SettlementBook.open('group-1');
    const proposal = proposePayment(book);
    expect(proposal.isSuccess()).toBe(true);
    expect(book.pullDomainEvents()).toEqual([]);

    const kept = book.keepPayment(proposal.isSuccess() ? proposal.data : (undefined as never), PAYMENT_LINK);
    expect(kept.isSuccess() && kept.data).toEqual({
      _id: proposal.isSuccess() ? proposal.data.settlementId : '',
      groupId: 'group-1',
      from: BOB,
      to: ANN,
      amount: 30,
      at: '2026-11-17T10:00:00.000Z',
      method: 'provider',
      status: 'pending',
      providerPaymentId: 'pay_1',
      payUrl: 'https://provider.example/pay/pay_1',
    });
    const events = book.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['PaymentRequestedEvent']);
  });

  it('refuses a payment the rules refuse before the provider is asked, and keeps nothing', () => {
    const refused = proposePayment(SettlementBook.open('group-1'), { amount: 31 });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementExceedsBalance');
  });

  it('keeps nothing, and is ProviderUnavailable, when the provider gave no link or a link that is not one', () => {
    for (const link of [null, { id: '', payUrl: 'https://provider.example/pay' }, { id: 'pay_1', payUrl: '' }]) {
      const book = SettlementBook.open('group-1');
      const proposal = proposePayment(book);
      if (proposal.isFailure()) throw new Error('the proposal should be decided');
      const refused = book.keepPayment(proposal.data, link);
      expect(refused.isFailure() && refused.error.type).toBe('ProviderUnavailable');
      expect(book.pullDomainEvents()).toEqual([]);
      expect(book.toSnapshot().recorded).toEqual([]);
    }
  });

  it('counts a pending payment as paid for what is still owed: a second payment cannot pay what is waiting', () => {
    const { book } = bookWithPendingPayment();
    // Bob owes 30 and 30 is waiting: he owes nothing still, and Ann is owed nothing still.
    const again = proposePayment(book, { amount: 1 });
    expect(again.isFailure() && again.error.type).toBe('SettlementExceedsBalance');
    const cash = recordCash(book, { amount: 1 });
    expect(cash.isFailure() && cash.error.type).toBe('SettlementExceedsBalance');
  });

  it('pays a settlement when the provider says it succeeded, once, and records SettlementPaid', () => {
    const { book } = bookWithPendingPayment();
    book.pullDomainEvents();
    const received = book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' });
    expect(received.isSuccess()).toBe(true);
    expect(book.hasChanges()).toBe(true);
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);

    // A repeated success, or a later failure, changes nothing: the payment ended once.
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' });
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' });
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('fails a settlement when the provider says it failed, and frees what it held', () => {
    const { book } = bookWithPendingPayment();
    book.pullDomainEvents();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' });
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementFailedEvent']);

    // What was waiting is free again: Bob may pay Ann the 30 once more.
    expect(proposePayment(book).isSuccess()).toBe(true);
  });

  it('changes nothing for a pending status, an unknown status or a payment the book does not hold', () => {
    const { book } = bookWithPendingPayment();
    // Read back, as a later writer reads it: nothing has moved since.
    const reader = reread(book, book.toSnapshot().recorded);
    reader.receiveProviderUpdate({ paymentId: 'pay_1', status: 'pending' });
    reader.receiveProviderUpdate({ paymentId: 'pay_1', status: 'authorised' });
    reader.receiveProviderUpdate({ paymentId: 'pay_unknown', status: 'succeeded' });
    reader.receiveProviderUpdate({ paymentId: 'pay_unknown', status: 'refunded' });
    expect(reader.hasChanges()).toBe(false);
    expect(reader.pullDomainEvents()).toEqual([]);
  });

  it('keeps the status a later reader of the book sees, and reports only what moved since it was read', () => {
    const { book, settlementId } = bookWithPendingPayment();
    const first = book.toSnapshot();
    expect(first.recorded.map(settlement => settlement._id)).toEqual([settlementId]);
    expect(first.changed).toEqual([]);

    const reader = reread(book, first.recorded);
    reader.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' });
    const moved = reader.toSnapshot();
    expect(moved.recorded).toEqual([]);
    expect(moved.changed).toEqual([expect.objectContaining({ _id: settlementId, status: 'paid' })]);
  });
});

/** A book that holds one payment through the provider from Bob to Ann of 30, paid: the provider said it succeeded. */
function bookWithPaidPayment(): { book: SettlementBook; settlementId: string } {
  const { book, settlementId } = bookWithPendingPayment();
  book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' });
  book.pullDomainEvents();
  return { book, settlementId };
}

/** Ann, the payee, asks for the refund of the settlement, with the members as they are now. */
const askRefund = (
  book: SettlementBook,
  settlementId: string,
  overrides: { asker?: string; members?: string[] } = {},
) => book.proposeRefund({ settlementId, asker: ANN, members: MEMBERS, ...overrides });

function proposalOf(book: SettlementBook, settlementId: string) {
  const proposal = askRefund(book, settlementId);
  if (proposal.isFailure()) throw new Error('the refund should be decided');
  return proposal.data;
}

describe('SettlementBook, a refund through the provider (request 15)', () => {
  it('refunds a paid payment asked by its payee, and keeps it refunding once the provider accepted it, recording RefundRequested', () => {
    const { book, settlementId } = bookWithPaidPayment();
    const proposal = askRefund(book, settlementId);
    expect(proposal.isSuccess() && proposal.data).toEqual({ settlementId, paymentId: 'pay_1' });
    expect(book.pullDomainEvents()).toEqual([]);

    const kept = book.keepRefund(proposalOf(book, settlementId), true);
    expect(kept.isSuccess() && kept.data.status).toBe('refunding');
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['RefundRequestedEvent']);
    expect(book.toSnapshot().recorded).toEqual([expect.objectContaining({ _id: settlementId, status: 'refunding' })]);
  });

  it('refuses a refund asked by anyone but the payee, as not allowed, and changes nothing', () => {
    const { book, settlementId } = bookWithPaidPayment();
    const refused = askRefund(book, settlementId, { asker: BOB });
    expect(refused.isFailure() && refused.error.type).toBe('NotAllowed');
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('refuses a refund of a settlement that is not there, as not found', () => {
    const { book } = bookWithPaidPayment();
    const refused = askRefund(book, 'settlement-unknown');
    expect(refused.isFailure() && refused.error.type).toBe('NotFound');
  });

  it('refuses a refund of what is not a paid payment through the provider: pending, failed, refunding, refunded or in cash', () => {
    const { book: pending, settlementId: pendingId } = bookWithPendingPayment();
    expect(askRefund(pending, pendingId).isFailure()).toBe(true);
    const refused = askRefund(pending, pendingId);
    expect(refused.isFailure() && refused.error.type).toBe('SettlementNotRefundable');

    const cash = SettlementBook.open('group-1');
    const recorded = recordCash(cash);
    if (recorded.isFailure()) throw new Error('the cash settlement should be recorded');
    const inCash = askRefund(cash, recorded.data._id);
    expect(inCash.isFailure() && inCash.error.type).toBe('SettlementNotRefundable');

    const { book: refunding, settlementId: refundingId } = bookWithPaidPayment();
    refunding.keepRefund(proposalOf(refunding, refundingId), true);
    const again = askRefund(refunding, refundingId);
    expect(again.isFailure() && again.error.type).toBe('SettlementNotRefundable');

    const { book: failed, settlementId: failedId } = bookWithPendingPayment();
    failed.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' });
    const failedRefund = askRefund(failed, failedId);
    expect(failedRefund.isFailure() && failedRefund.error.type).toBe('SettlementNotRefundable');
  });

  it('refuses a refund once one of the two has left the group, so that the balances still add up to 0', () => {
    const { book, settlementId } = bookWithPaidPayment();
    const payerLeft = askRefund(book, settlementId, { members: [ANN, CY] });
    expect(payerLeft.isFailure() && payerLeft.error.type).toBe('SettlementNotRefundable');
    const payeeLeft = askRefund(book, settlementId, { members: [BOB, CY] });
    expect(payeeLeft.isFailure() && payeeLeft.error.type).toBe('SettlementNotRefundable');
  });

  it('is refused as ProviderUnavailable, and nothing moves, when the provider did not accept the refund', () => {
    const { book, settlementId } = bookWithPaidPayment();
    const refused = book.keepRefund(proposalOf(book, settlementId), false);
    expect(refused.isFailure() && refused.error.type).toBe('ProviderUnavailable');
    expect(book.pullDomainEvents()).toEqual([]);
    expect(book.toSnapshot().recorded).toEqual([expect.objectContaining({ _id: settlementId, status: 'paid' })]);
    expect(askRefund(book, settlementId).isSuccess()).toBe(true);
  });

  it('records SettlementRefunded once when the provider says a paid or refunding payment is refunded, and nothing after', () => {
    const { book, settlementId } = bookWithPaidPayment();
    book.keepRefund(proposalOf(book, settlementId), true);
    book.pullDomainEvents();

    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' });
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' });
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' });
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementRefundedEvent']);
    expect(askRefund(book, settlementId).isFailure()).toBe(true);
  });

  it('keeps a refunded payment refunded when a succeeded webhook arrives after it, and counts it for nothing', () => {
    const { book, settlementId } = bookWithPendingPayment();
    book.pullDomainEvents();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' });
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' });
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' });

    // A refunded that overtook the success leaves the settlement refunded, and never records it as paid.
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementRefundedEvent']);
    expect(book.toSnapshot().recorded).toEqual([expect.objectContaining({ _id: settlementId, status: 'refunded' })]);
  });

  it('changes nothing when a refunded webhook arrives for a payment that failed', () => {
    const { book } = bookWithPendingPayment();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' });
    book.pullDomainEvents();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' });
    expect(book.pullDomainEvents()).toEqual([]);
  });
});

describe("SettlementBook and the payee's payout account (request 16)", () => {
  it('refuses a payment to a payee with no payout account, as PayeeHasNoPayoutAccount, and records nothing', () => {
    const book = SettlementBook.open('group-1');
    const refused = proposePayment(book, {}, null);
    expect(refused.isFailure() && refused.error.type).toBe('PayeeHasNoPayoutAccount');
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('proposes the payment to the payout account of its payee, the one the provider is asked to pay', () => {
    const proposal = proposePayment(SettlementBook.open('group-1'), {}, 'acct_bob');
    if (proposal.isFailure()) throw new Error('the proposal should be decided');
    expect(proposal.data.payeeAccount).toBe('acct_bob');
  });

  it('keeps a cash settlement needing no payout account', () => {
    expect(recordCash(SettlementBook.open('group-1')).isSuccess()).toBe(true);
  });
});
