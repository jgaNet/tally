import { StatementEntryView } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { CountedSettlement } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';

/** An expense of a member's statement before its balance: what it is for, and the instant it was recorded (request 29). */
export interface StatementExpense {
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  /** An instant, ISO 8601 in UTC; '' for an expense recorded before the instant was kept (docs/adr/0028). */
  recordedAt: string;
}

/** What a settlement's line says of its method (request 29). */
const SETTLEMENT_DESCRIPTION: Record<CountedSettlement['method'], string> = {
  cash: 'Settlement in cash',
  provider: 'Settlement through the provider',
};

/** The day of an instant, in UTC. */
const dayOfInstant = (instant: string): string => new Date(instant).toISOString().slice(0, 10);

/**
 * A member's statement (request 8, request 29, docs/adr/0028): the expenses the member paid or is in the split of, and the counted
 * settlements they paid or received, the earliest day first and, on the same day, the earliest moment first: an expense by when it was
 * recorded, a settlement by when the balances started to count it. On the same moment an expense comes first. Each line carries the
 * member's balance once it is counted, starting from 0.
 *
 * `expenses` are given in the order of recording, so an expense recorded at the same moment keeps that order.
 */
export function memberStatementEntries(
  memberId: string,
  expenses: StatementExpense[],
  settlements: CountedSettlement[],
): StatementEntryView[] {
  const lines: Array<{ date: string; at: string; entry: Omit<StatementEntryView, 'balance'> }> = [
    ...expenses.map(expense => ({
      date: expense.date,
      at: expense.recordedAt,
      entry: {
        kind: 'expense' as const,
        expenseId: expense.expenseId,
        date: expense.date,
        description: expense.description,
        paid: expense.paid,
        share: expense.share,
      },
    })),
    ...[...settlements]
      .sort((a, b) => (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0))
      .filter(settlement => settlement.payerId === memberId || settlement.payeeId === memberId)
      .map(settlement => ({
        date: dayOfInstant(settlement.countedFrom),
        at: settlement.countedFrom,
        entry: {
          kind: 'settlement' as const,
          settlementId: settlement.settlementId,
          date: dayOfInstant(settlement.countedFrom),
          description: SETTLEMENT_DESCRIPTION[settlement.method],
          paid: settlement.payerId === memberId ? settlement.amount : 0,
          share: settlement.payeeId === memberId ? settlement.amount : 0,
        },
      })),
  ];
  // The sort is stable: on a tie, the expenses (listed first) keep their order of recording, and come before the settlements.
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  let balance = 0;
  return lines.map(({ entry }): StatementEntryView => {
    balance += entry.paid - entry.share;
    return { ...entry, balance } as StatementEntryView;
  });
}
