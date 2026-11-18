import { decideRecordCashSettlement } from './SettlementBook.decision';
import { SettlementBook } from './SettlementBook';

const members = ['ada', 'grace', 'linus'];
const balances = new Map([
  ['ada', 30],
  ['grace', -30],
]);
const payeeAda = (from: string, amount: number, given = { archived: false, memberIds: members, balances }) =>
  decideRecordCashSettlement(given, { payee: 'ada', from, amount }, new Date('2026-01-01T00:00:00Z'));

describe('decideRecordCashSettlement (request 12)', () => {
  it('allows a payment no more than the payer owes and no more than the payee is owed, and says who paid whom', () => {
    const decision = payeeAda('grace', 30);
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state).toEqual({ from: 'grace', to: 'ada', amount: 30 });
  });

  it('refuses a payment more than the payer owes, and changes nothing', () => {
    const decision = payeeAda('grace', 31);
    expect(decision.isFailure()).toBe(true);
    expect((decision.error as { type: string }).type).toBe('SettlementMoreThanOwed');
  });

  it('refuses a payment more than the payee is owed', () => {
    const decision = decideRecordCashSettlement(
      { archived: false, memberIds: members, balances },
      { payee: 'linus', from: 'grace', amount: 1 },
      new Date(),
    );
    expect((decision.error as { type: string }).type).toBe('SettlementMoreThanIsOwed');
  });

  it('refuses an amount of 0 or less, and a payer who is the payee or not a member', () => {
    expect((payeeAda('grace', 0).error as { type: string }).type).toBe('InvalidSettlementAmount');
    expect((payeeAda('grace', 1.5).error as { type: string }).type).toBe('InvalidSettlementAmount');
    expect((payeeAda('ada', 1).error as { type: string }).type).toBe('SettlementToSelf');
    expect((payeeAda('zed', 1).error as { type: string }).type).toBe('SettlementPayerNotMember');
  });
});

describe('SettlementBook', () => {
  it('records a settlement with its own id, the event, and the version it was read at', () => {
    const book = SettlementBook.open('group-1');
    expect(book.version).toBe(0);
    const id = book.recordCash({ from: 'grace', to: 'ada', amount: 30, at: new Date('2026-01-01T00:00:00Z') });
    expect(book.recorded()).toEqual([
      {
        id,
        groupId: 'group-1',
        from: 'grace',
        to: 'ada',
        amount: 30,
        method: 'cash',
        status: 'paid',
        at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(book.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses a stored book whose version no save could have stored', () => {
    expect(() => SettlementBook.fromSnapshot({ id: 'b', groupId: 'g', version: 0, payments: [] })).toThrow();
  });
});
