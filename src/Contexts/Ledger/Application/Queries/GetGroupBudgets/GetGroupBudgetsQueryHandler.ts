import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IBudgetQueries } from '@Contexts/Ledger/Application/Ports/IBudgetQueries';
import { BudgetReadModel } from '@Contexts/Ledger/Application/ReadModel/BudgetReadModel';

/** A member of the group reads its budgets, in the order of the categories, with what the current month (UTC) spends. For anyone else the group does not exist. */
export class GetGroupBudgetsQueryHandler extends QueryHandler<
  IBudgetQueries,
  { groupId: string },
  IResult<BudgetReadModel[]>
> {
  constructor(
    queries: IBudgetQueries,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<BudgetReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const role = await this.groupMembers.roleOf(new Id(groupId), caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    const month = this.clock().toISOString().slice(0, 7);
    return Result.ok(await this.queries.listByGroup(groupId, month));
  }
}
