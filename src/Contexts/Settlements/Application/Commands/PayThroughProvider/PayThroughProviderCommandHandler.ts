import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { IGroupCurrency } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupCurrency';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { PayThroughProviderCommandEvent } from '@Contexts/Settlements/Application/Commands/PayThroughProvider/PayThroughProviderCommandEvent';

/**
 * A member pays another member of the group through the provider (ADR 8): the payer is the caller. The book checks the rules
 * on what is still owed, asks the provider for a payment link for the settlement's id, and keeps the settlement pending once
 * the provider has answered; nothing is kept when the provider does not answer, and the book decides again with the link in
 * hand. Inside the command's transaction the balances are read with the book, so a settlement decided at once conflicts and is
 * decided again (CONC-OPTIMISTIC). For anyone who is not a member of the group, the group does not exist. The result is the
 * settlement's id.
 */
export class PayThroughProviderCommandHandler extends CommandHandler<PayThroughProviderCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly balances: IGroupBalances,
    private readonly members: ISettlementMembers,
    private readonly currencies: IGroupCurrency,
    private readonly provider: IPaymentProvider,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    { payload }: PayThroughProviderCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string }>> {
    const payer = requireSignedIn(context, 'Settlements');
    if (payer.isFailure()) return payer;

    const members = await this.members.currentMembers(payload.groupId);
    const currency = await this.currencies.currencyOf(payload.groupId);
    if (!members.includes(payer.data.value) || currency === null) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    }

    const book = await this.books.findByGroup(new Id(payload.groupId));
    const balances = await this.balances.balancesOf(payload.groupId);
    const proposed = book.proposePayment({
      payer: payer.data,
      payee: new Id(payload.to),
      amount: payload.amount,
      balances,
      members,
    });
    if (proposed.isFailure()) return proposed;

    const link = await this.provider.createPayment({
      reference: proposed.data.id.value,
      amount: payload.amount,
      currency,
    });
    if (link.isFailure()) return link;

    const kept = book.keepPayment(proposed.data, link.data, this.clock());
    if (kept.isFailure()) return kept;
    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok({ id: kept.data.id.value });
  }
}
