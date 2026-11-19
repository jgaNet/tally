import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { IStatementQueries } from '@Contexts/Ledger/Application/Ports/IStatementQueries';
import {
  SettlementLine,
  StatementEntryReadModel,
  StatementLine,
  StatementReadModel,
} from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';

/** What a member's statement is read from: the expenses, the settlements the balances count, and the members. */
export interface MemberStatementReads {
  queries: IStatementQueries;
  groupMembers: IGroupMembers;
  settled: ISettledAmounts;
}

/**
 * A member of the group reads the statement of any member of the group, a former one included, themselves included: the
 * expenses the member paid or is in the split of, and the settlements they paid or received that the balances count (request
 * 29), the earliest date first and, on the same date, the earliest first (an expense by when it was recorded, a settlement by
 * when the balances started to count it), each with the balance once it is counted, from 0. For anyone else the group does
 * not exist; a statement of an account that has never been a member of the group does not exist either.
 */
export async function readMemberStatement(
  reads: MemberStatementReads,
  { groupId, memberId }: { groupId: string; memberId: string },
  caller: Id,
): Promise<IResult<StatementReadModel>> {
  // The lines are read before the members, as the balances are (GetGroupBalances).
  const expenses = await reads.queries.entriesOf(groupId, memberId);
  const counted = await reads.settled.countedOf(groupId, memberId);
  const members = await reads.groupMembers.currentMembers(new Id(groupId));
  if (!members.some(member => member.equals(caller))) {
    return Result.fail(new NotFoundException('Ledger', 'Group not found'));
  }
  if (!(await reads.groupMembers.hasBeenMember(new Id(groupId), new Id(memberId)))) {
    return Result.fail(new NotFoundException('Ledger', 'Member not found'));
  }

  // A settlement's line: paid for its payer, the share for its payee, dated by the UTC day it started to count.
  const settlements: SettlementLine[] = counted.map(settlement => {
    const payer = settlement.payerId === memberId;
    return {
      kind: 'settlement',
      settlementId: settlement.settlementId,
      date: new Date(settlement.countedFrom).toISOString().slice(0, 10),
      description:
        settlement.method === 'cash'
          ? 'Settlement in cash'
          : settlement.method === 'net'
            ? 'Settlement by netting'
            : 'Settlement through the provider',
      paid: payer ? settlement.amount : 0,
      share: payer ? 0 : settlement.amount,
      at: settlement.countedFrom,
    };
  });

  // The order is the statement's: the date, then the instant (an expense's recording, a settlement's counting). The sort is
  // stable, so an expense and a settlement at the same instant keep the expense first.
  const lines: StatementLine[] = [...expenses, ...settlements].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : Date.parse(a.at) - Date.parse(b.at),
  );

  // The balance is counted here, in the statement's order: nothing is stored per entry.
  let balance = 0;
  const entries = lines.map((line): StatementEntryReadModel => {
    balance += line.paid - line.share;
    return line.kind === 'expense'
      ? {
          kind: 'expense',
          expenseId: line.expenseId,
          date: line.date,
          description: line.description,
          paid: line.paid,
          share: line.share,
          balance,
        }
      : {
          kind: 'settlement',
          settlementId: line.settlementId,
          date: line.date,
          description: line.description,
          paid: line.paid,
          share: line.share,
          balance,
        };
  });
  return Result.ok({ memberId, balance, entries });
}

export class GetMemberStatementQueryHandler extends QueryHandler<
  IStatementQueries,
  { groupId: string; memberId: string },
  IResult<StatementReadModel>
> {
  constructor(
    queries: IStatementQueries,
    private readonly groupMembers: IGroupMembers,
    private readonly settled: ISettledAmounts,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<StatementReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;
    return readMemberStatement(
      { queries: this.queries, groupMembers: this.groupMembers, settled: this.settled },
      { groupId, memberId },
      caller.data,
    );
  }
}
