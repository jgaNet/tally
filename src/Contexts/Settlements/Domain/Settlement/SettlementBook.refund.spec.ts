import { Id, NotFoundException } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  RefundRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRefundedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  CashSettlementNotRefundable,
  NotThePayee,
  PayerNotAMember,
  SettlementNotPaid,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

const NOW = new Date('2026-11-01T10:00:00.000Z');

const at = new Date('2026-01-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -30],
  ['payee', 30],
]);

/** A book with one settlement through the provider, kept pending and then paid by the provider's word. */
function paidThroughProvider(): { book: SettlementBook; settlementId: Id } {
  const book = SettlementBook.open(Id.generate(), 0);
  const proposal = book.proposePayment({
    groupArchived: false,
    payer,
    payee,
    amount: 30,
    balances,
    members,
    payeeAccount: 'acct-payee',
  });
  if (proposal.isFailure()) throw new Error('the payment must be proposed');
  const kept = book.keepPayment(proposal.data, { id: 'prov-1', payUrl: 'https://pay.example/prov-1' }, at);
  if (kept.isFailure()) throw new Error('the payment must be kept');
  book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: NOW });
  book.pullDomainEvents();
  return { book, settlementId: proposal.data.id };
}

/** The same book, with its settlement's status as the book keeps it. */
function statusOf(book: SettlementBook, settlementId: Id): string | undefined {
  return book.unsaved.find(settlement => settlement.id.equals(settlementId))?.status;
}

describe('SettlementBook: the payee refunds a settlement paid through the provider, whole (request 15)', () => {
  it('proposes the refund for the payee of a paid settlement, and keeps it refunding, still counted, with RefundRequested', () => {
    const { book, settlementId } = paidThroughProvider();

    const proposal = book.proposeRefund({ groupArchived: false, settlementId, caller: payee, members });
    if (proposal.isFailure()) throw new Error('the refund must be proposed');
    expect(proposal.data.paymentId).toBe('prov-1');

    const kept = book.keepRefund(proposal.data, at);
    expect(kept.isSuccess()).toBe(true);
    expect(statusOf(book, settlementId)).toBe('refunding');
    const events = book.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(RefundRequestedEvent);
  });

  it('refuses a refund that is not the payee’s, and changes nothing', () => {
    const { book, settlementId } = paidThroughProvider();

    const proposal = book.proposeRefund({ groupArchived: false, settlementId, caller: payer, members });
    expect(proposal.isFailure() && proposal.error instanceof NotThePayee).toBe(true);
    expect(book.unsaved).toHaveLength(1);
    expect(statusOf(book, settlementId)).toBe('paid');
  });

  it('refuses a settlement in cash, which is not refunded through Tally', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const cash = book.recordCash({ groupArchived: false, payer, payee, amount: 30, balances, members, at });
    if (cash.isFailure()) throw new Error('the cash settlement must be recorded');

    const proposal = book.proposeRefund({ groupArchived: false, settlementId: cash.data.id, caller: payee, members });
    expect(proposal.isFailure() && proposal.error instanceof CashSettlementNotRefundable).toBe(true);
  });

  it('refuses a settlement that is not paid, pending or already refunded', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({
      groupArchived: false,
      payer,
      payee,
      amount: 30,
      balances,
      members,
      payeeAccount: 'acct-payee',
    });
    if (proposal.isFailure()) throw new Error('the payment must be proposed');
    book.keepPayment(proposal.data, { id: 'prov-2', payUrl: 'https://pay.example/prov-2' }, at);

    const pending = book.proposeRefund({
      groupArchived: false,
      settlementId: proposal.data.id,
      caller: payee,
      members,
    });
    expect(pending.isFailure() && pending.error instanceof SettlementNotPaid).toBe(true);
  });

  it('refuses a refund once the payer has left the group, so the balances still add up to 0', () => {
    const { book, settlementId } = paidThroughProvider();

    const proposal = book.proposeRefund({ groupArchived: false, settlementId, caller: payee, members: ['payee'] });
    expect(proposal.isFailure() && proposal.error instanceof PayerNotAMember).toBe(true);
  });

  it('answers a settlement as not found to anyone who is not a member of the group', () => {
    const { book, settlementId } = paidThroughProvider();

    const proposal = book.proposeRefund({ groupArchived: false, settlementId, caller: new Id('stranger'), members });
    expect(proposal.isFailure() && proposal.error instanceof NotFoundException).toBe(true);
  });
});

describe('SettlementBook: the provider says a payment is refunded, and it is never counted again (request 15, request 14)', () => {
  it('makes a paid settlement refunded, and records SettlementRefunded', () => {
    const { book, settlementId } = paidThroughProvider();

    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: NOW });

    expect(statusOf(book, settlementId)).toBe('refunded');
    const events = book.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementRefundedEvent);
  });

  it('makes a refunding settlement refunded once the provider says so', () => {
    const { book, settlementId } = paidThroughProvider();
    const proposal = book.proposeRefund({ groupArchived: false, settlementId, caller: payee, members });
    if (proposal.isFailure()) throw new Error('the refund must be proposed');
    book.keepRefund(proposal.data, at);

    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: NOW });

    expect(statusOf(book, settlementId)).toBe('refunded');
  });

  it('leaves a refunded settlement refunded when the same word arrives again, and counts it once', () => {
    const { book } = paidThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: NOW });
    book.pullDomainEvents();

    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: NOW });

    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('ends a refund that overtakes the success of the same payment as refunded, never paid', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({
      groupArchived: false,
      payer,
      payee,
      amount: 30,
      balances,
      members,
      payeeAccount: 'acct-payee',
    });
    if (proposal.isFailure()) throw new Error('the payment must be proposed');
    book.keepPayment(proposal.data, { id: 'prov-3', payUrl: 'https://pay.example/prov-3' }, at);
    book.pullDomainEvents();

    book.receivePayment({ paymentId: 'prov-3', status: 'refunded', at: NOW });
    book.receivePayment({ paymentId: 'prov-3', status: 'succeeded', at: NOW });
    book.receivePayment({ paymentId: 'prov-3', status: 'pending', at: NOW });

    expect(statusOf(book, proposal.data.id)).toBe('refunded');
    const events = book.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementRefundedEvent);
    expect(events.some(event => event instanceof SettlementPaidEvent)).toBe(false);
  });

  it('refuses a refund by GroupArchived, and changes nothing', () => {
    const { book, settlementId } = paidThroughProvider();

    const proposal = book.proposeRefund({ settlementId, caller: payee, members, groupArchived: true });

    expect(proposal.isFailure()).toBe(true);
    expect((proposal.error as { type?: string } | undefined)?.type).toBe('GroupArchived');
    expect(statusOf(book, settlementId)).toBe('paid');
    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('changes nothing for a succeeded or pending word that arrives after a refund', () => {
    const { book, settlementId } = paidThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: NOW });
    book.pullDomainEvents();

    book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: NOW });
    book.receivePayment({ paymentId: 'prov-1', status: 'pending', at: NOW });

    expect(statusOf(book, settlementId)).toBe('refunded');
    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('does not refund a settlement the provider said failed', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({
      groupArchived: false,
      payer,
      payee,
      amount: 30,
      balances,
      members,
      payeeAccount: 'acct-payee',
    });
    if (proposal.isFailure()) throw new Error('the payment must be proposed');
    book.keepPayment(proposal.data, { id: 'prov-4', payUrl: 'https://pay.example/prov-4' }, at);
    book.receivePayment({ paymentId: 'prov-4', status: 'failed', at: NOW });
    book.pullDomainEvents();

    book.receivePayment({ paymentId: 'prov-4', status: 'refunded', at: NOW });

    expect(statusOf(book, proposal.data.id)).toBe('failed');
    expect(book.pullDomainEvents().some(event => event instanceof SettlementFailedEvent)).toBe(false);
    expect(book.pullDomainEvents()).toHaveLength(0);
  });
});
