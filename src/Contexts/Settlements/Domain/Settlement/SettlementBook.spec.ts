import { Id } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  InvalidSettlementAmount,
  PayerIsPayee,
  PayerNotAMember,
  SettlementExceedsDebt,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

const NOW = new Date('2026-11-01T10:00:00.000Z');

const at = new Date('2026-01-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];

function decide(amount: number, balances: Map<string, number>, overrides: { payer?: Id; members?: string[] } = {}) {
  const book = SettlementBook.open(Id.generate(), 0);
  const result = book.recordCash({
    payer: overrides.payer ?? payer,
    payee,
    amount,
    balances,
    members: overrides.members ?? members,
    at,
  });
  return { book, result };
}

describe('SettlementBook: a cash settlement is never more than is owed', () => {
  it('records a settlement up to what the payer owes and what the payee is owed, and records SettlementRecorded', () => {
    const { book, result } = decide(
      30,
      new Map([
        ['payer', -30],
        ['payee', 30],
      ]),
    );

    expect(result.isSuccess()).toBe(true);
    expect(book.unsaved).toHaveLength(1);
    expect(book.unsaved[0].amount).toBe(30);
    expect(book.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses more than the payer owes, and records nothing', () => {
    const { book, result } = decide(
      31,
      new Map([
        ['payer', -30],
        ['payee', 40],
      ]),
    );

    expect(result.isFailure() && result.error instanceof SettlementExceedsDebt).toBe(true);
    expect(book.unsaved).toHaveLength(0);
    expect(book.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses more than the payee is owed', () => {
    const { result } = decide(
      31,
      new Map([
        ['payer', -40],
        ['payee', 30],
      ]),
    );

    expect(result.isFailure() && result.error instanceof SettlementExceedsDebt).toBe(true);
  });

  it('refuses a payee who is owed nothing, and a payer who owes nothing', () => {
    expect(decide(1, new Map([['payer', -30]])).result.isFailure()).toBe(true);
    expect(
      decide(
        1,
        new Map([
          ['payer', 30],
          ['payee', 30],
        ]),
      ).result.isFailure(),
    ).toBe(true);
  });

  it('refuses an amount that is not a whole number of at least 1', () => {
    for (const amount of [0, -5, 1.5]) {
      const { result } = decide(
        amount,
        new Map([
          ['payer', -30],
          ['payee', 30],
        ]),
      );
      expect(result.isFailure() && result.error instanceof InvalidSettlementAmount).toBe(true);
    }
  });

  it('refuses a payer who is the payee, and a payer who is not a member', () => {
    const same = SettlementBook.open(Id.generate(), 0).recordCash({
      payer,
      payee: payer,
      amount: 1,
      balances: new Map([['payer', -30]]),
      members,
      at,
    });
    expect(same.isFailure() && same.error instanceof PayerIsPayee).toBe(true);

    const stranger = decide(
      1,
      new Map([
        ['payer', -30],
        ['payee', 30],
      ]),
      { members: ['payee'] },
    );
    expect(stranger.result.isFailure() && stranger.result.error instanceof PayerNotAMember).toBe(true);
  });
});

describe('SettlementBook: a payment through the provider waits, counts as paid for what is still owed, and ends once', () => {
  const balances = new Map([
    ['payer', -30],
    ['payee', 30],
  ]);
  const decision = { payer, payee, balances, members, payeeAccount: 'acct-payee' as string | undefined };

  function kept(amount: number, book = SettlementBook.open(Id.generate(), 0)) {
    const proposal = book.proposePayment({ ...decision, amount });
    if (proposal.isFailure()) throw new Error('refused');
    const settlement = book.keepPayment(proposal.data, { id: `pay-${amount}`, payUrl: `https://pay/${amount}` }, at);
    return { book, settlement };
  }

  it('keeps a payment pending with its link, and records PaymentRequested without counting it', () => {
    const { book, settlement } = kept(20);

    expect(settlement.isSuccess()).toBe(true);
    expect(book.unsaved).toHaveLength(1);
    expect(book.unsaved[0]).toMatchObject({ method: 'provider', status: 'pending', providerPaymentId: 'pay-20' });
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['PaymentRequestedEvent']);
  });

  it('counts what is waiting as paid: asks for no more than is still owed', () => {
    const { book } = kept(20);
    const again = book.proposePayment({ ...decision, amount: 15 });

    expect(again.isFailure()).toBe(true);
    expect((again.error as { type?: string } | undefined)?.type).toBe('SettlementExceedsDebt');
    expect(book.proposePayment({ ...decision, amount: 10 }).isSuccess()).toBe(true);
  });

  it('refuses a payee with no payout account by name, before the provider is asked, and keeps nothing', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({ ...decision, payeeAccount: undefined, amount: 20 });

    expect(proposal.isFailure()).toBe(true);
    expect((proposal.error as { type?: string } | undefined)?.type).toBe('PayeeHasNoPayoutAccount');
    expect(book.unsaved).toHaveLength(0);
  });

  it('asks a payment for the payee account it is given, and keeps the proposal with it', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({ ...decision, amount: 20 });

    expect(proposal.isSuccess()).toBe(true);
    expect(proposal.data).toMatchObject({ payeeAccount: 'acct-payee', amount: 20 });
  });

  it('refuses a payee who is not a member of the group', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({ ...decision, payee: new Id('stranger'), amount: 5 });

    expect(proposal.isFailure()).toBe(true);
    expect((proposal.error as { type?: string } | undefined)?.type).toBe('PayeeNotAMember');
  });

  it('becomes paid when the provider says it succeeded, and records SettlementPaid', () => {
    const { book } = kept(20);
    book.pullDomainEvents();
    book.receivePayment({ paymentId: 'pay-20', status: 'succeeded', at: NOW });

    expect(book.unsaved[0].status).toBe('paid');
    expect(book.pullDomainEvents().map(event => event.name)).toEqual(['SettlementPaidEvent']);
  });

  it('becomes failed when the provider says it failed, and frees what it held', () => {
    const { book } = kept(20);
    book.receivePayment({ paymentId: 'pay-20', status: 'failed', at: NOW });

    expect(book.unsaved[0].status).toBe('failed');
    expect(book.proposePayment({ ...decision, amount: 30 }).isSuccess()).toBe(true);
  });

  it('changes nothing for a pending word, an unknown payment, a word it does not know, or a payment already ended', () => {
    const { book } = kept(20);
    book.receivePayment({ paymentId: 'pay-20', status: 'pending', at: NOW });
    book.receivePayment({ paymentId: 'unknown', status: 'succeeded', at: NOW });
    book.receivePayment({ paymentId: 'pay-20', status: 'disputed', at: NOW });
    expect(book.unsaved[0].status).toBe('pending');

    book.receivePayment({ paymentId: 'pay-20', status: 'succeeded', at: NOW });
    book.receivePayment({ paymentId: 'pay-20', status: 'failed', at: NOW });
    expect(book.unsaved[0].status).toBe('paid');
    expect(book.pullDomainEvents()).toHaveLength(2);
  });
});
