import { memberStatementEntries, StatementExpense } from '@Contexts/Ledger/Domain/Expense/Statement';
import { CountedSettlement } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';

const expense = (
  expenseId: string,
  date: string,
  recordedAt: string,
  paid: number,
  share: number,
): StatementExpense => ({
  expenseId,
  date,
  description: expenseId,
  paid,
  share,
  recordedAt,
});

describe('a member statement (request 29, docs/adr/0028)', () => {
  it('orders an expense and a settlement of the same day by the moment each was recorded or started to count', () => {
    const expenses = [expense('dinner', '2026-03-01', '2026-03-01T10:00:00.000Z', 3000, 1000)];
    const settlements: CountedSettlement[] = [
      {
        settlementId: 'late',
        payerId: 'ann',
        payeeId: 'bob',
        amount: 500,
        method: 'cash',
        countedFrom: '2026-03-01T18:00:00.000Z',
      },
      {
        settlementId: 'early',
        payerId: 'bob',
        payeeId: 'ann',
        amount: 200,
        method: 'provider',
        countedFrom: '2026-03-01T09:00:00.000Z',
      },
    ];
    const entries = memberStatementEntries('ann', expenses, settlements);
    expect(entries.map(entry => (entry.kind === 'expense' ? entry.expenseId : entry.settlementId))).toEqual([
      'early',
      'dinner',
      'late',
    ]);
    expect(entries.map(entry => entry.balance)).toEqual([-200, 1800, 2300]);
  });

  it('gives a settlement its method in words, the paid side to the payer and the share to the payee, and leaves out the settlements that are not the member’s', () => {
    const settlements: CountedSettlement[] = [
      {
        settlementId: 'cash',
        payerId: 'bob',
        payeeId: 'ann',
        amount: 700,
        method: 'cash',
        countedFrom: '2026-04-01T00:00:00.000Z',
      },
      {
        settlementId: 'provider',
        payerId: 'ann',
        payeeId: 'cy',
        amount: 900,
        method: 'provider',
        countedFrom: '2026-04-02T00:00:00.000Z',
      },
      {
        settlementId: 'other',
        payerId: 'bob',
        payeeId: 'cy',
        amount: 50,
        method: 'cash',
        countedFrom: '2026-04-02T00:00:00.000Z',
      },
    ];
    expect(memberStatementEntries('ann', [], settlements)).toEqual([
      {
        kind: 'settlement',
        settlementId: 'cash',
        date: '2026-04-01',
        description: 'Settlement in cash',
        paid: 0,
        share: 700,
        balance: -700,
      },
      {
        kind: 'settlement',
        settlementId: 'provider',
        date: '2026-04-02',
        description: 'Settlement through the provider',
        paid: 900,
        share: 0,
        balance: 200,
      },
    ]);
  });

  it('puts an expense recorded before the instant was kept first on its day', () => {
    const entries = memberStatementEntries(
      'ann',
      [expense('old', '2026-05-01', '', 1000, 0), expense('new', '2026-05-01', '2026-05-01T08:00:00.000Z', 0, 400)],
      [
        {
          settlementId: 's',
          payerId: 'bob',
          payeeId: 'ann',
          amount: 100,
          method: 'cash',
          countedFrom: '2026-05-01T07:00:00.000Z',
        },
      ],
    );
    expect(entries.map(entry => entry.balance)).toEqual([1000, 1000 - 100, 1000 - 100 - 400]);
    expect(entries[0]).toMatchObject({ kind: 'expense', expenseId: 'old' });
  });
});
