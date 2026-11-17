import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';

/** A signed-in person reads their own account, and nobody else's: there is no id to ask for. */
export class GetMyAccountQueryHandler extends QueryHandler<IAccountQueries, void, IResult<AccountReadModel>> {
  async execute(_: void, context: ExecutionContext): Promise<IResult<AccountReadModel>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const account = await this.queries.findById(caller.data.value);
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found', { id: caller.data.value }));
    return Result.ok(account);
  }
}
