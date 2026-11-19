import { decideRequestProviderPayment, ProviderPaymentGiven, providerOutcomeOf } from './SettlementBook.decision';
import { SettlementBook } from './SettlementBook';

const members = ['ada', 'grace', 'linus'];
const balances = new Map([
  ['ada', 30],
  ['grace', -30],
]);
const now = new Date('2026-01-01T00:00:00Z');
const request = (
  payer: string,
  to: string,
  amount: number,
  given: ProviderPaymentGiven = {
    archived: false,
    suspended: false,
    memberIds: members,
    balances,
    payeeAccount: 'acct_ada',
  },
) => decideRequestProviderPayment(given, { payer, to, amount }, now);
const typeOf = (decision: { error?: unknown }) => (decision.error as { type: string }).type;

describe('decideRequestProviderPayment (request 13)', () => {
  it('allows a payment no more than the payer owes, to a member no more than is owed, and gives the settlement its own id', () => {
    const decision = request('grace', 'ada', 30);
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state).toEqual({
      id: expect.any(String),
      from: 'grace',
      to: 'ada',
      amount: 30,
      payeeAccount: 'acct_ada',
    });
    expect(decision.data!.state.id).not.toBe(request('grace', 'ada', 30).data!.state.id);
  });

  it('refuses the same rules as a cash settlement: more than owed, more than owed to the payee, a payee not a member, to self', () => {
    expect(typeOf(request('grace', 'ada', 31))).toBe('SettlementMoreThanOwed');
    const thinPayee = new Map([
      ['ada', 5],
      ['grace', -30],
    ]);
    expect(
      typeOf(
        request('grace', 'ada', 10, {
          archived: false,
          suspended: false,
          memberIds: members,
          balances: thinPayee,
          payeeAccount: 'acct_ada',
        }),
      ),
    ).toBe('SettlementMoreThanIsOwed');
    expect(typeOf(request('grace', 'zed', 1))).toBe('SettlementPayeeNotMember');
    expect(typeOf(request('grace', 'grace', 1))).toBe('SettlementToSelf');
    expect(typeOf(request('grace', 'ada', 0))).toBe('InvalidSettlementAmount');
    expect(typeOf(request('zed', 'ada', 1))).toBe('SettlementPayerNotMember');
  });
});

describe("decideRequestProviderPayment, the payee's payout account (request 16)", () => {
  it("gives the provider the payee's account, and refuses a payee with none by its name, before any provider is asked", () => {
    const allowed = request('grace', 'ada', 30);
    expect(allowed.data!.state).toEqual({
      id: expect.any(String),
      from: 'grace',
      to: 'ada',
      amount: 30,
      payeeAccount: 'acct_ada',
    });
    const none = request('grace', 'ada', 30, {
      archived: false,
      suspended: false,
      memberIds: members,
      balances,
      payeeAccount: undefined,
    });
    expect(typeOf(none)).toBe('PayeeHasNoPayoutAccount');
  });
});

describe('SettlementBook with payments through the provider (request 13)', () => {
  const at = new Date('2026-01-01T00:00:00Z');

  it('records a payment pending at the provider with its link, and records PaymentRequested', () => {
    const book = SettlementBook.open('group-1');
    book.requestPayment({
      id: 'settlement-1',
      from: 'grace',
      to: 'ada',
      amount: 30,
      at,
      providerPaymentId: 'pay_1',
      payUrl: 'https://pay.example/1',
    });
    expect(book.recorded()).toEqual([
      {
        id: 'settlement-1',
        groupId: 'group-1',
        from: 'grace',
        to: 'ada',
        amount: 30,
        method: 'provider',
        status: 'pending',
        at: '2026-01-01T00:00:00.000Z',
        providerPaymentId: 'pay_1',
        payUrl: 'https://pay.example/1',
      },
    ]);
    expect(book.pullDomainEvents().map(event => event.constructor.name)).toEqual(['PaymentRequestedEvent']);
  });

  it('counts a waiting payment as paid for what is still owed, and moves it once to paid or failed, never back', () => {
    const book = SettlementBook.fromSnapshot({
      id: 'b',
      groupId: 'group-1',
      version: 3,
      payments: [
        {
          id: 'settlement-1',
          from: 'grace',
          to: 'ada',
          amount: 30,
          providerPaymentId: 'pay_1',
          payUrl: 'https://pay.example/1',
          status: 'pending',
        },
      ],
    });
    expect(
      book
        .stillOwed(
          new Map([
            ['ada', 30],
            ['grace', -30],
          ]),
        )
        .get('grace'),
    ).toBe(0);

    book.settlePayment('pay_1', 'paid', new Date('2026-05-01T10:00:00Z'));
    book.settlePayment('pay_1', 'failed', new Date('2026-05-01T10:05:00Z'));
    expect(book.moved()).toEqual([{ id: 'settlement-1', status: 'paid', at: '2026-05-01T10:00:00.000Z' }]);
    expect(book.pendingPayments()).toEqual([]);
    expect(book.pullDomainEvents().map(event => event.constructor.name)).toEqual(['SettlementPaidEvent']);
  });

  it('answers the provider outcome of a status: succeeded is paid, failed is failed, refunded is refunded, anything else changes nothing', () => {
    expect(providerOutcomeOf('succeeded')).toBe('paid');
    expect(providerOutcomeOf('failed')).toBe('failed');
    expect(providerOutcomeOf('refunded')).toBe('refunded');
    expect(providerOutcomeOf('pending')).toBeUndefined();
  });
});
