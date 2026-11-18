import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { AccountDeletedException, AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { PayThroughProviderCommandEvent } from '@Contexts/Settlements/Application/Commands/PayThroughProvider/PayThroughProviderCommandEvent';

/**
 * Paying through the provider (request 13): the signed-in member who owes pays a member of the group an amount through the
 * provider. The book decides the payment first, against what is still owed, so a refused payment never reaches the provider;
 * then the provider is asked for a payment link with the settlement's id as the reference, and the book keeps the settlement
 * pending with that link, deciding again with it in hand. A provider that does not give a link refuses the payment and nothing
 * is kept. A payee with no payout account at the provider is refused before the provider is asked (request 16). To anyone who is
 * not a member the group does not exist. The book is saved and what it recorded is published with the
 * save, in one transaction; its answer is the settlement's id.
 */
export class PayThroughProviderCommandHandler extends CommandHandler<PayThroughProviderCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private balances: IGroupBalances,
    private books: ISettlementBookRepository,
    private payoutAccounts: IPayoutAccountRepository,
    private provider: IPaymentProvider,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: PayThroughProviderCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const payer = caller.data.value;

    const { groupId, to, amount } = event.payload;
    const members = await this.settlementMembers.membersOf(groupId, payer);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    if (await this.settlementMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    // A suspended payer pays nothing through the provider, in any group (request 34).
    if (await this.settlementMembers.isSuspended(payer)) return Result.fail(new AccountSuspendedException());
    // A deleted payee is paid through the provider by no one, in any group (request 35).
    if (await this.settlementMembers.isDeleted(event.payload.to)) return Result.fail(new AccountDeletedException());
    const currency = await this.settlementMembers.currencyOf(groupId, payer);
    if (!currency) return Result.fail(new NotFoundException('Settlements', 'Group not found'));

    const balances = await this.balances.balancesOf(groupId);
    const book = (await this.books.findByGroupId(groupId)) ?? SettlementBook.open(groupId);

    const payee = await this.payoutAccounts.findByOwner(to);
    const proposed = book.proposePayment(
      {
        payer,
        payee: to,
        amount,
        at: this.clock(),
        members: members.map(member => member.memberId),
        balances,
      },
      payee?.accountId ?? null,
    );
    if (proposed.isFailure()) return Result.fail(proposed.error);

    const link = await this.provider.requestPayment({
      reference: proposed.data.settlementId,
      amount,
      currency,
      payee: proposed.data.payeeAccount,
    });

    const kept = book.keepPayment(proposed.data, link);
    if (kept.isFailure()) return Result.fail(kept.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(kept.data._id);
  }
}
