import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import {
  IPayoutAccountQueries,
  PayoutAccountView,
} from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountQueries';

/**
 * A signed-in member reads their own payout account (request 16): the provider's id of the account they are paid on. Nobody
 * else reads it, and a member with none is not found.
 */
export class GetPayoutAccountQueryHandler extends QueryHandler<
  IPayoutAccountQueries,
  void,
  IResult<PayoutAccountView>
> {
  async execute(_payload: void, context: ExecutionContext): Promise<IResult<PayoutAccountView>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);

    const account = await this.queries.findByOwner(caller.data.value);
    if (!account) return Result.fail(new NotFoundException('Settlements', 'Payout account not found'));
    return Result.ok(account);
  }
}
