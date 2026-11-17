import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IPayoutAccountQueries } from '@Contexts/Settlements/Application/Ports/IPayoutAccountQueries';
import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';

/** A signed-in person reads their own payout account, and nobody else's: none, for a person who has set none (request 16). */
export class GetPayoutAccountQueryHandler extends QueryHandler<
  IPayoutAccountQueries,
  void,
  IResult<PayoutAccountReadModel>
> {
  async execute(_: void, context: ExecutionContext): Promise<IResult<PayoutAccountReadModel>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;
    const account = await this.queries.findByOwner(caller.data.value);
    return account ? Result.ok(account) : Result.fail(new NotFoundException('Settlements', 'Payout account not found'));
  }
}
