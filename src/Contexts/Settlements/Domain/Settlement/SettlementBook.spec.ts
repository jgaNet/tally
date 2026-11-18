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
      settled: 30,
      fee: null,
      at: '2026-11-17T10:00:00.000Z',
      method: 'cash',
      status: 'paid',
      providerPaymentId: null,
      payUrl: null,
      contested: false,
      original: null,
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

const PAYMENT_LINK = { id: 'pay_1', payUrl: 'https://provider.example/pay/pay_1', fee: 0 };
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
      settled: 30,
      fee: { amount: 0, borneBy: 'payee' },
      at: '2026-11-17T10:00:00.000Z',
      method: 'provider',
      status: 'pending',
      providerPaymentId: 'pay_1',
      payUrl: 'https://provider.example/pay/pay_1',
      contested: false,
      original: null,
    });
    const events = book.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['PaymentRequestedEvent']);
  });

  it('refuses a payment the rules refuse before the provider is asked, and keeps nothing', () => {
    const refused = proposePayment(SettlementBook.open('group-1'), { amount: 31 });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementExceedsBalance');
  });

  it('keeps nothing, and is ProviderUnavailable, when the provider gave no link or a link that is not one', () => {
    for (const link of [
      null,
      { id: '', payUrl: 'https://provider.example/pay', fee: 0 },
      { id: 'pay_1', payUrl: '', fee: 0 },
    ]) {
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
    const received = book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' }, AT);
    expect(received.isSuccess()).toBe(true);
    expect(book.hasChanges()).toBe(true);
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);

    // A repeated success, or a later failure, changes nothing: the payment ended once.
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' }, AT);
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' }, AT);
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('fails a settlement when the provider says it failed, and frees what it held', () => {
    const { book } = bookWithPendingPayment();
    book.pullDomainEvents();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' }, AT);
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementFailedEvent']);

    // What was waiting is free again: Bob may pay Ann the 30 once more.
    expect(proposePayment(book).isSuccess()).toBe(true);
  });

  it('changes nothing for a pending status, an unknown status or a payment the book does not hold', () => {
    const { book } = bookWithPendingPayment();
    // Read back, as a later writer reads it: nothing has moved since.
    const reader = reread(book, book.toSnapshot().recorded);
    reader.receiveProviderUpdate({ paymentId: 'pay_1', status: 'pending' }, AT);
    reader.receiveProviderUpdate({ paymentId: 'pay_1', status: 'authorised' }, AT);
    reader.receiveProviderUpdate({ paymentId: 'pay_unknown', status: 'succeeded' }, AT);
    reader.receiveProviderUpdate({ paymentId: 'pay_unknown', status: 'refunded' }, AT);
    expect(reader.hasChanges()).toBe(false);
    expect(reader.pullDomainEvents()).toEqual([]);
  });

  it('keeps the status a later reader of the book sees, and reports only what moved since it was read', () => {
    const { book, settlementId } = bookWithPendingPayment();
    const first = book.toSnapshot();
    expect(first.recorded.map(settlement => settlement._id)).toEqual([settlementId]);
    expect(first.changed).toEqual([]);

    const reader = reread(book, first.recorded);
    reader.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' }, AT);
    const moved = reader.toSnapshot();
    expect(moved.recorded).toEqual([]);
    expect(moved.changed).toEqual([expect.objectContaining({ _id: settlementId, status: 'paid' })]);
  });
});

/** A book that holds one payment through the provider from Bob to Ann of 30, paid: the provider said it succeeded. */
function bookWithPaidPayment(): { book: SettlementBook; settlementId: string } {
  const { book, settlementId } = bookWithPendingPayment();
  book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' }, AT);
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

    const kept = book.keepRefund(proposalOf(book, settlementId), true, AT);
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
    refunding.keepRefund(proposalOf(refunding, refundingId), true, AT);
    const again = askRefund(refunding, refundingId);
    expect(again.isFailure() && again.error.type).toBe('SettlementNotRefundable');

    const { book: failed, settlementId: failedId } = bookWithPendingPayment();
    failed.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' }, AT);
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
    const refused = book.keepRefund(proposalOf(book, settlementId), false, AT);
    expect(refused.isFailure() && refused.error.type).toBe('ProviderUnavailable');
    expect(book.pullDomainEvents()).toEqual([]);
    expect(book.toSnapshot().recorded).toEqual([expect.objectContaining({ _id: settlementId, status: 'paid' })]);
    expect(askRefund(book, settlementId).isSuccess()).toBe(true);
  });

  it('records SettlementRefunded once when the provider says a paid or refunding payment is refunded, and nothing after', () => {
    const { book, settlementId } = bookWithPaidPayment();
    book.keepRefund(proposalOf(book, settlementId), true, AT);
    book.pullDomainEvents();

    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' }, AT);
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' }, AT);
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' }, AT);
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementRefundedEvent']);
    expect(askRefund(book, settlementId).isFailure()).toBe(true);
  });

  it('keeps a refunded payment refunded when a succeeded webhook arrives after it, and counts it for nothing', () => {
    const { book, settlementId } = bookWithPendingPayment();
    book.pullDomainEvents();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' }, AT);
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'succeeded' }, AT);
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' }, AT);

    // A refunded that overtook the success leaves the settlement refunded, and never records it as paid.
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementRefundedEvent']);
    expect(book.toSnapshot().recorded).toEqual([expect.objectContaining({ _id: settlementId, status: 'refunded' })]);
  });

  it('changes nothing when a refunded webhook arrives for a payment that failed', () => {
    const { book } = bookWithPendingPayment();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'failed' }, AT);
    book.pullDomainEvents();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' }, AT);
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

describe('SettlementBook’s history (request 19)', () => {
  const LATER = new Date('2026-11-17T11:00:00.000Z');

  it('gives a cash settlement one line, paid, at the time it was recorded', () => {
    const book = SettlementBook.open('group-1');
    const recorded = recordCash(book);
    const settlementId = recorded.isSuccess() ? recorded.data._id : '';

    expect(book.toSnapshot().history).toEqual([{ settlementId, status: 'paid', at: AT.toISOString() }]);
  });

  it('gives a provider payment a line when it is kept, and only the status the provider moves it to, dated when the book learned it', () => {
    const { book, settlementId } = bookWithPendingPayment();
    expect(book.toSnapshot().history).toEqual([{ settlementId, status: 'pending', at: AT.toISOString() }]);

    // Refunded for a payment that never succeeded: the line is refunded alone, no `paid` is invented.
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'refunded' }, LATER);
    expect(book.toSnapshot().history).toEqual([
      { settlementId, status: 'pending', at: AT.toISOString() },
      { settlementId, status: 'refunded', at: LATER.toISOString() },
    ]);
  });

  it('adds no line for a webhook that changes nothing', () => {
    const { book, settlementId } = bookWithPendingPayment();
    book.receiveProviderUpdate({ paymentId: 'pay_1', status: 'pending' }, LATER);
    book.receiveProviderUpdate({ paymentId: 'pay_unknown', status: 'succeeded' }, LATER);

    expect(book.toSnapshot().history).toEqual([{ settlementId, status: 'pending', at: AT.toISOString() }]);
  });

  it('gives a refund asked of a paid payment a line, refunding, at the time it is kept', () => {
    const { book, settlementId } = bookWithPaidPayment();
    const proposed = book.proposeRefund({ settlementId, asker: ANN, members: MEMBERS });
    expect(proposed.isSuccess()).toBe(true);
    if (proposed.isFailure()) return;

    book.keepRefund(proposed.data, true, LATER);
    expect(book.toSnapshot().history).toEqual([
      { settlementId, status: 'pending', at: AT.toISOString() },
      { settlementId, status: 'paid', at: AT.toISOString() },
      { settlementId, status: 'refunding', at: LATER.toISOString() },
    ]);
  });
});

const LATER = new Date('2026-11-18T10:00:00.000Z');
/** A book read from the store holding one payment through the provider, paid: nothing since it was read is a change. */
function readBookWithPaidPayment(): { book: SettlementBook; settlementId: string } {
  const { book, settlementId } = bookWithPaidPayment();
  return { book: reread(book, book.toSnapshot().recorded), settlementId };
}

const contest = (book: SettlementBook, settlementId: string, overrides: { asker?: string; members?: string[] } = {}) =>
  book.contest({ settlementId, asker: ANN, members: MEMBERS, ...overrides }, LATER);

describe('SettlementBook, a contested settlement (request 33)', () => {
  it('moves a paid payment its payee contests to contested, once, recording SettlementContested and its audit entry', () => {
    const { book, settlementId } = readBookWithPaidPayment();

    const contested = contest(book, settlementId);

    expect(contested.isSuccess() && contested.data.status).toBe('contested');
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementContestedEvent']);
    expect(book.newAuditEntries).toEqual([
      expect.objectContaining({ action: 'settlement-contested', by: ANN, subjectId: settlementId, amount: 30 }),
    ]);
    expect(book.toSnapshot().history.map(line => line.status)).toContain('contested');
    expect(contest(book, settlementId).isFailure()).toBe(true);
  });

  it('refuses a contest by anyone but the payee, of what is not a paid payment through the provider, or of a member who left', () => {
    const { book, settlementId } = readBookWithPaidPayment();
    const byPayer = contest(book, settlementId, { asker: BOB });
    expect(byPayer.isFailure() && byPayer.error.type).toBe('NotAllowed');
    const left = contest(book, settlementId, { members: [ANN] });
    expect(left.isFailure() && left.error.type).toBe('SettlementNotContestable');
    const missing = contest(book, 'nothing');
    expect(missing.isFailure() && missing.error.type).toBe('NotFound');
    expect(book.hasChanges()).toBe(false);

    const pending = bookWithPendingPayment();
    const early = contest(pending.book, pending.settlementId);
    expect(early.isFailure() && early.error.type).toBe('SettlementNotContestable');

    const cash = SettlementBook.open('group-1');
    const recorded = recordCash(cash);
    const cashId = recorded.isSuccess() ? recorded.data._id : '';
    const inCash = contest(cash, cashId);
    expect(inCash.isFailure() && inCash.error.type).toBe('SettlementNotContestable');
  });

  it('decides a contest once: paid again, with an audit entry by the administrator, or annulled, with none, each in the log', () => {
    const paid = readBookWithPaidPayment();
    contest(paid.book, paid.settlementId);
    paid.book.pullDomainEvents();
    const decided = paid.book.decideContest(
      { settlementId: paid.settlementId, paid: true, administrator: 'root' },
      LATER,
    );
    expect(decided.isSuccess() && decided.data.status).toBe('paid');
    expect(paid.book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);
    expect(paid.book.newAuditEntries.map(entry => [entry.action, entry.by])).toEqual([
      ['settlement-contested', ANN],
      ['settlement-paid', 'root'],
    ]);
    expect(paid.book.toSnapshot().decisions).toEqual([
      {
        id: expect.any(String),
        at: LATER.toISOString(),
        by: 'root',
        action: 'decided-paid',
        subjectId: paid.settlementId,
      },
    ]);
    const again = paid.book.decideContest(
      { settlementId: paid.settlementId, paid: false, administrator: 'root' },
      LATER,
    );
    expect(again.isFailure() && again.error.type).toBe('SettlementNotContested');
    expect(contest(paid.book, paid.settlementId).isFailure()).toBe(true);

    const annulled = readBookWithPaidPayment();
    contest(annulled.book, annulled.settlementId);
    annulled.book.pullDomainEvents();
    const result = annulled.book.decideContest(
      { settlementId: annulled.settlementId, paid: false, administrator: 'root' },
      LATER,
    );
    expect(result.isSuccess() && result.data.status).toBe('annulled');
    expect(annulled.book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementAnnulledEvent']);
    expect(annulled.book.newAuditEntries.map(entry => entry.action)).toEqual(['settlement-contested']);
    expect(annulled.book.toSnapshot().decisions).toEqual([expect.objectContaining({ action: 'decided-annulled' })]);
  });

  it('counts a contested settlement as waiting for what is still owed, and an annulled one no more', () => {
    const { book, settlementId } = readBookWithPaidPayment();
    contest(book, settlementId);
    // The balances do not count it, so Bob owes 30 again, and Ann is owed 30; it waits, so nothing more is payable.
    expect(book.payable({ payer: BOB, payee: ANN, balances: BALANCES })).toBe(0);

    book.decideContest({ settlementId, paid: false, administrator: 'root' }, LATER);
    expect(book.payable({ payer: BOB, payee: ANN, balances: BALANCES })).toBe(30);
  });
});

describe('who bears the provider’s fee (request 38)', () => {
  const OWNER_BALANCES = [
    { memberId: BOB, balance: -300 },
    { memberId: ANN, balance: 300 },
  ];

  it('is the payee until the owner decides, and only the owner decides it', () => {
    const book = SettlementBook.open('group-1');
    expect(book.feeBorneBy).toBe('payee');
    expect(book.setFeePolicy({ borneBy: 'payer', asker: BOB, owner: ANN }).isFailure()).toBe(true);
    expect(book.setFeePolicy({ borneBy: 'nobody', asker: ANN, owner: ANN }).isFailure()).toBe(true);
    expect(book.setFeePolicy({ borneBy: 'shared', asker: ANN, owner: ANN }).isSuccess()).toBe(true);
    expect(book.feeBorneBy).toBe('shared');
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['FeePolicySetEvent']);
  });

  it('settles the shared fee with the payee bearing the extra hundredth: Bob bears 15 of a fee of 31, and it settles 285', () => {
    const book = SettlementBook.open('group-1');
    expect(book.setFeePolicy({ borneBy: 'shared', asker: ANN, owner: ANN }).isSuccess()).toBe(true);
    const proposal = proposePayment(book, { amount: 300, balances: OWNER_BALANCES });
    if (proposal.isFailure()) throw new Error('the proposal should be decided');

    const kept = book.keepPayment(proposal.data, { ...PAYMENT_LINK, fee: 31 });
    expect(kept.isSuccess() && kept.data).toMatchObject({
      amount: 300,
      settled: 285,
      fee: { amount: 31, borneBy: 'shared' },
    });
  });

  it('settles the whole amount when the payee bears the fee, and the amount less the fee when the payer does', () => {
    const payeeBook = SettlementBook.open('group-1');
    const payeeProposal = proposePayment(payeeBook, { amount: 300, balances: OWNER_BALANCES });
    if (payeeProposal.isFailure()) throw new Error('the proposal should be decided');
    expect(payeeBook.keepPayment(payeeProposal.data, { ...PAYMENT_LINK, fee: 31 })).toMatchObject({
      data: { settled: 300, fee: { borneBy: 'payee' } },
    });

    const payerBook = SettlementBook.open('group-1');
    payerBook.setFeePolicy({ borneBy: 'payer', asker: ANN, owner: ANN });
    const payerProposal = proposePayment(payerBook, { amount: 300, balances: OWNER_BALANCES });
    if (payerProposal.isFailure()) throw new Error('the proposal should be decided');
    expect(payerBook.keepPayment(payerProposal.data, { ...PAYMENT_LINK, fee: 31 })).toMatchObject({
      data: { settled: 269, fee: { amount: 31, borneBy: 'payer' } },
    });
  });

  it('refuses a fee that is not less than the amount, and keeps nothing', () => {
    const book = SettlementBook.open('group-1');
    const proposal = proposePayment(book);
    if (proposal.isFailure()) throw new Error('the proposal should be decided');
    expect(book.keepPayment(proposal.data, { ...PAYMENT_LINK, fee: 30 }).isFailure()).toBe(true);
    expect(book.pullDomainEvents()).toEqual([]);
  });
});

describe('SettlementBook, a settlement in another currency (request 39)', () => {
  /** Bob owes Ann 30 in the group's currency: 30 CHF at 0.93 is 27.9, which rounds to 28, and Bob owes that in full. */
  const CHF_OFFER = { kind: 'offered', rate: '0.93' } as const;

  it('records a cash settlement in another currency at the offered rate, keeping the rate and both amounts', () => {
    const book = SettlementBook.open('group-1');
    const recorded = recordCash(book, {
      amount: { original: { currency: 'CHF', amount: 30 }, groupCurrency: 'EUR', offer: CHF_OFFER },
    });
    expect(recorded.isSuccess() && recorded.data).toMatchObject({
      amount: 28,
      settled: 28,
      method: 'cash',
      status: 'paid',
      original: { currency: 'CHF', amount: 30, rate: '0.93' },
    });
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementRecordedEvent']);
  });

  it('refuses a settlement in another currency when no rate is offered, recording nothing', () => {
    const book = SettlementBook.open('group-1');
    const refused = recordCash(book, {
      amount: { original: { currency: 'CHF', amount: 30 }, groupCurrency: 'EUR', offer: { kind: 'none' } },
    });
    expect(refused.isFailure() && refused.error.type).toBe('NoRateOffered');
    expect(book.pullDomainEvents()).toEqual([]);
    expect(book.toSnapshot().recorded).toEqual([]);
  });

  it('decides the converted amount against what is owed, not the original one', () => {
    const book = SettlementBook.open('group-1');
    const refused = recordCash(book, {
      amount: {
        original: { currency: 'CHF', amount: 33 },
        groupCurrency: 'EUR',
        offer: { kind: 'offered', rate: '1' },
      },
    });
    expect(refused.isFailure() && refused.error.type).toBe('SettlementExceedsBalance');
  });

  it('keeps the provider fee, in the payment currency, converted at the settlement rate (10 CHF at 0.93 is 9)', () => {
    const book = SettlementBook.open('group-1');
    const proposal = book.proposePayment(
      {
        payer: BOB,
        payee: ANN,
        amount: {
          original: { currency: 'CHF', amount: 30 },
          groupCurrency: 'EUR',
          offer: { kind: 'offered', rate: '0.93' },
        },
        at: AT,
        members: MEMBERS,
        balances: BALANCES,
      },
      'acct_ann',
    );
    expect(proposal.isSuccess()).toBe(true);
    const kept = book.keepPayment(proposal.isSuccess() ? proposal.data : (undefined as never), {
      id: 'pay_9',
      payUrl: 'https://provider.example/pay/pay_9',
      fee: 10,
    });
    expect(kept.isSuccess() && kept.data).toMatchObject({
      amount: 28,
      settled: 28,
      fee: { amount: 9, borneBy: 'payee' },
      method: 'provider',
      status: 'pending',
      original: { currency: 'CHF', amount: 30, rate: '0.93' },
    });
  });
});
