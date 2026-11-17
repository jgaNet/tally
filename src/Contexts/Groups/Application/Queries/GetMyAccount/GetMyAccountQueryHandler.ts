import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { AccountView, IAccountQueries } from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';

/** A signed-in person reads their own account, and nobody else's: the caller's id is the only one asked for. */
export class GetMyAccountQueryHandler extends QueryHandler<IAccountQueries, undefined, IResult<AccountView>> {
  async execute(_: undefined, context: ExecutionContext): Promise<IResult<AccountView>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const account = await this.queries.findAccount(caller.data.value);
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found'));

    return Result.ok(account);
  }
}
