import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';

/** A signed-in person reads their own account, and nobody else's. */
export class GetMyAccountQueryHandler extends QueryHandler<IAccountQueries, void, IResult<AccountReadModel>> {
  async execute(_: void, context: ExecutionContext): Promise<IResult<AccountReadModel>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;
    const account = await this.queries.findById(caller.data.value);
    return account ? Result.ok(account) : Result.fail(new NotFoundException('Groups', 'Account not found'));
  }
}
