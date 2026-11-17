import { decideRequestProviderPayment, providerOutcomeOf } from './SettlementBook.decision';
import { SettlementBook } from './SettlementBook';

const members = ['ada', 'grace', 'linus'];
const balances = new Map([
  ['ada', 30],
  ['grace', -30],
]);
const now = new Date('2026-01-01T00:00:00Z');
const request = (payer: string, to: string, amount: number, given = { memberIds: members, balances }) =>
  decideRequestProviderPayment(given, { payer, to, amount }, now);
const typeOf = (decision: { error?: unknown }) => (decision.error as { type: string }).type;

describe('decideRequestProviderPayment (request 13)', () => {
  it('allows a payment no more than the payer owes, to a member no more than is owed, and gives the settlement its own id', () => {
    const decision = request('grace', 'ada', 30);
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state).toEqual({ id: expect.any(String), from: 'grace', to: 'ada', amount: 30 });
    expect(decision.data!.state.id).not.toBe(request('grace', 'ada', 30).data!.state.id);
  });

  it('refuses the same rules as a cash settlement: more than owed, more than owed to the payee, a payee not a member, to self', () => {
    expect(typeOf(request('grace', 'ada', 31))).toBe('SettlementMoreThanOwed');
    const thinPayee = new Map([
      ['ada', 5],
      ['grace', -30],
    ]);
    expect(typeOf(request('grace', 'ada', 10, { memberIds: members, balances: thinPayee }))).toBe(
      'SettlementMoreThanIsOwed',
    );
    expect(typeOf(request('grace', 'zed', 1))).toBe('SettlementPayeeNotMember');
    expect(typeOf(request('grace', 'grace', 1))).toBe('SettlementToSelf');
    expect(typeOf(request('grace', 'ada', 0))).toBe('InvalidSettlementAmount');
    expect(typeOf(request('zed', 'ada', 1))).toBe('SettlementPayerNotMember');
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
      pending: [
        {
          id: 'settlement-1',
          from: 'grace',
          to: 'ada',
          amount: 30,
          providerPaymentId: 'pay_1',
          payUrl: 'https://pay.example/1',
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

    book.settlePayment('pay_1', 'paid');
    book.settlePayment('pay_1', 'failed');
    expect(book.settled()).toEqual([{ id: 'settlement-1', status: 'paid' }]);
    expect(book.pendingPayments()).toEqual([]);
    expect(book.pullDomainEvents().map(event => event.constructor.name)).toEqual(['SettlementPaidEvent']);
  });

  it('answers the provider outcome of a status: succeeded is paid, failed is failed, anything else changes nothing', () => {
    expect(providerOutcomeOf('succeeded')).toBe('paid');
    expect(providerOutcomeOf('failed')).toBe('failed');
    expect(providerOutcomeOf('pending')).toBeUndefined();
    expect(providerOutcomeOf('refunded')).toBeUndefined();
  });
});
