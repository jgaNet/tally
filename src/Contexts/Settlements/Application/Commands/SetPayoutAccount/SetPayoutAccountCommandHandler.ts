import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SetPayoutAccountCommandEvent } from '@Contexts/Settlements/Application/Commands/SetPayoutAccount/SetPayoutAccountCommandEvent';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';

/**
 * A signed-in person sets the account they are paid on: the provider is asked whether it knows the account, and the payout account
 * takes its answer or refuses it (the provider's answer is the one fact the aggregate cannot know). Setting another account replaces
 * the one the person had. Nothing is set, and nothing is saved, when the provider does not know the account.
 */
export class SetPayoutAccountCommandHandler extends CommandHandler<SetPayoutAccountCommandEvent> {
  constructor(
    private accounts: IPayoutAccountRepository,
    private provider: IPaymentProvider,
  ) {
    super();
  }

  async execute({ payload }: SetPayoutAccountCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const account = (await this.accounts.findByOwner(caller.data)) ?? PayoutAccount.open(caller.data);
    const known = await this.provider.payoutAccountOf(payload.accountId);
    const set = account.set(payload.accountId, known);
    if (set.isFailure()) return set;

    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(account, context);
    return Result.ok();
  }
}
