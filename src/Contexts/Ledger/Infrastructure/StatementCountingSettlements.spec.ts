import { StatementCountingSettlements } from './StatementCountingSettlements';

/**
 * The statement's order and balances, over fake ports (request 29): a settlement is on the UTC day its balances started to count it, an expense
 * before a settlement on the same instant, an expense with no recorded instant before every settlement of its day, and the provider's description.
 */
const statementWith = (
  lines: { expenseId: string; recordedAt: string; date: string; description: string; paid: number; share: number }[],
  counted: {
    settlementId: string;
    from: string;
    to: string;
    amount: number;
    method: 'cash' | 'provider';
    countedAt: string;
  }[],
) =>
  new StatementCountingSettlements(
    { expenseLinesOf: async () => lines },
    { countedOf: async () => counted },
  ).statementOf('group', 'ada');

describe('the statement of a member, the settlements among its expenses (request 29)', () => {
  it('puts a settlement on the UTC day it started to count, after the expenses of earlier days', async () => {
    const statement = await statementWith(
      [
        {
          expenseId: 'e1',
          recordedAt: '2025-03-01T09:00:00.000Z',
          date: '2025-03-01',
          description: 'Rent',
          paid: 100,
          share: 50,
        },
      ],
      [
        {
          settlementId: 's1',
          from: 'grace',
          to: 'ada',
          amount: 20,
          method: 'provider',
          countedAt: '2025-03-02T00:30:00.000Z',
        },
      ],
    );

    expect(statement.entries).toEqual([
      { kind: 'expense', expenseId: 'e1', date: '2025-03-01', description: 'Rent', paid: 100, share: 50, balance: 50 },
      {
        kind: 'settlement',
        settlementId: 's1',
        date: '2025-03-02',
        description: 'Settlement through the provider',
        paid: 0,
        share: 20,
        balance: 30,
      },
    ]);
    expect(statement.balance).toBe(30);
  });

  it('orders by the instant on the same day, and on the same instant the expense first', async () => {
    const statement = await statementWith(
      [
        {
          expenseId: 'before',
          recordedAt: '2025-03-05T10:00:00.000Z',
          date: '2025-03-05',
          description: 'Before',
          paid: 0,
          share: 10,
        },
        {
          expenseId: 'same',
          recordedAt: '2025-03-05T12:00:00.000Z',
          date: '2025-03-05',
          description: 'Same',
          paid: 0,
          share: 10,
        },
        { expenseId: 'legacy', recordedAt: '', date: '2025-03-05', description: 'Legacy', paid: 0, share: 10 },
      ],
      [
        {
          settlementId: 's-early',
          from: 'ada',
          to: 'grace',
          amount: 5,
          method: 'cash',
          countedAt: '2025-03-05T11:00:00.000Z',
        },
        {
          settlementId: 's-same',
          from: 'ada',
          to: 'grace',
          amount: 5,
          method: 'cash',
          countedAt: '2025-03-05T12:00:00.000Z',
        },
      ],
    );

    expect(statement.entries.map(entry => (entry.kind === 'expense' ? entry.expenseId : entry.settlementId))).toEqual([
      'legacy',
      'before',
      's-early',
      'same',
      's-same',
    ]);
  });

  it('is at 0 with no entries', async () => {
    expect(await statementWith([], [])).toEqual({ memberId: 'ada', balance: 0, entries: [] });
  });
});
