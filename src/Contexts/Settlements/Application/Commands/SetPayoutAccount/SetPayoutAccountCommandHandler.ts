import { IResult, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { SetPayoutAccountCommandEvent } from '@Contexts/Settlements/Application/Commands/SetPayoutAccount/SetPayoutAccountCommandEvent';

/**
 * Setting the payout account of the signed-in member (request 16): the provider is asked whether it knows the account, and the
 * account keeps it, replacing the one held, or is refused by name (UnknownPayoutAccount, or ProviderUnavailable when the provider
 * did not answer as asked). Nothing is kept on a refusal. The account is saved and what it recorded is published with the save,
 * in one transaction; its answer is the account's id.
 */
export class SetPayoutAccountCommandHandler extends CommandHandler<SetPayoutAccountCommandEvent> {
  constructor(
    private payoutAccounts: IPayoutAccountRepository,
    private provider: IPaymentProvider,
  ) {
    super();
  }

  async execute(event: SetPayoutAccountCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const owner = caller.data.value;

    const { accountId } = event.payload;
    const account = (await this.payoutAccounts.findByOwner(owner)) ?? PayoutAccount.open(owner);
    const providerAnswer = await this.provider.knowsPayoutAccount(accountId);

    const set = account.set({ accountId, providerAnswer });
    if (set.isFailure()) return Result.fail(set.error);

    const saved = await this.payoutAccounts.save(account);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(account, context);
    return Result.ok(account._id.value);
  }
}
