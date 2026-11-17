import { CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { SetPayoutAccountCommandEvent } from '@Contexts/Settlements/Application/Commands/SetPayoutAccount/SetPayoutAccountCommandEvent';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';

/**
 * A signed-in person sets the payout account the provider pays them on (request 16). The provider is asked whether it knows the
 * account first: an account it does not know is refused (UnknownPayoutAccount), and nothing is set; an answer that is not one
 * the provider gives is refused too. Setting another account replaces the one the person had. The result is nothing.
 */
export class SetPayoutAccountCommandHandler extends CommandHandler<SetPayoutAccountCommandEvent> {
  constructor(
    private readonly payoutAccounts: IPayoutAccountRepository,
    private readonly provider: IPaymentProvider,
  ) {
    super();
  }

  async execute({ payload }: SetPayoutAccountCommandEvent, context: ExecutionContext): Promise<IResult> {
    const owner = requireSignedIn(context, 'Settlements');
    if (owner.isFailure()) return owner;

    const answer = await this.provider.findPayoutAccount(payload.accountId);
    if (answer.isFailure()) return answer;

    const existing = await this.payoutAccounts.findByOwner(owner.data);
    let account: PayoutAccount;
    if (existing) {
      const changed = existing.change({ accountId: payload.accountId, providerAnswer: answer.data });
      if (changed.isFailure()) return changed;
      account = existing;
    } else {
      const created = PayoutAccount.create({
        owner: owner.data,
        accountId: payload.accountId,
        providerAnswer: answer.data,
      });
      if (created.isFailure()) return created;
      account = created.data;
    }

    const saved = await this.payoutAccounts.save(account);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(account, context);
    return Result.ok();
  }
}
