import { IExpenseQueries } from '@Contexts/Ledger/Application/IExpenseQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IStatementQueries, StatementEntryView, StatementView } from '@Contexts/Ledger/Application/IStatementQueries';

/** What an entry is ordered by before it is read: its day, its instant, and whether it is an expense (0) or a settlement (1). */
interface Ordered {
  date: string;
  instant: number;
  rank: 0 | 1;
  entry: Omit<StatementEntryView, 'balance'>;
  memberPaid: number;
  memberShare: number;
}

/**
 * A member's statement, as Ledger reads it (request 29, ADR 26): the expenses the member paid or is in the split of, read from Ledger's own
 * expenses, and the settlements the balances count in which the member is the payer or the payee, read through Ledger's `SettledAmounts`
 * port (Settlements' read model, never copied). They are put in the order of a bank statement: the earliest date first (a settlement's day is
 * the UTC day its balances started to count it), then by instant, an expense when it was recorded and a settlement when it started to count,
 * and on the same instant the expense first. The running balance is computed here, at the read, in that order; nothing is stored per entry.
 */
export class StatementCountingSettlements implements IStatementQueries {
  constructor(
    private readonly expenses: Pick<IExpenseQueries, 'expenseLinesOf'>,
    private readonly settled: Pick<ISettledAmounts, 'countedOf'>,
  ) {}

  async statementOf(groupId: string, memberId: string): Promise<StatementView> {
    const items: Ordered[] = [
      ...(await this.expenses.expenseLinesOf(groupId, memberId)).map(line => ({
        date: line.date,
        instant: instantOf(line.recordedAt),
        rank: 0 as const,
        entry: {
          kind: 'expense' as const,
          expenseId: line.expenseId,
          date: line.date,
          description: line.description,
          paid: line.paid,
          share: line.share,
        },
        memberPaid: line.paid,
        memberShare: line.share,
      })),
      ...(await this.settled.countedOf(groupId, memberId)).map(settlement => {
        const paid = settlement.from === memberId ? settlement.amount : 0;
        const share = settlement.to === memberId ? settlement.amount : 0;
        const date = new Date(settlement.countedAt).toISOString().slice(0, 10);
        return {
          date,
          instant: instantOf(settlement.countedAt),
          rank: 1 as const,
          entry: {
            kind: 'settlement' as const,
            settlementId: settlement.settlementId,
            date,
            description: settlement.method === 'cash' ? 'Settlement in cash' : 'Settlement through the provider',
            paid,
            share,
          },
          memberPaid: paid,
          memberShare: share,
        };
      }),
    ];
    // A stable sort: the entries listed first keep their order on a tie, and the expenses are listed before the settlements.
    items.sort((a, b) => compare(a.date, b.date) || compare(a.instant, b.instant) || a.rank - b.rank);

    let balance = 0;
    const entries: StatementEntryView[] = items.map(item => {
      balance += item.memberPaid - item.memberShare;
      return { ...item.entry, balance } as StatementEntryView;
    });
    return { memberId, balance, entries };
  }
}

/** The instant of a record, in milliseconds since the epoch; a record with no instant (an expense a file held before it had one) is the first. */
const instantOf = (at: string): number => (at === '' ? Number.NEGATIVE_INFINITY : Date.parse(at));

/** The order of two days written YYYY-MM-DD, or of two instants in milliseconds (with -Infinity for the first). */
const compare = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
