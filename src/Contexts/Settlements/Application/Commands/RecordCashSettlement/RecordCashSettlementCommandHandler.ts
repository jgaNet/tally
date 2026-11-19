import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { IGroupCurrency } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupCurrency';
import { OtherCurrencyPayment } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { offerForPayment } from '@Contexts/Settlements/Application/Commands/offerForPayment';
import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RecordCashSettlement/RecordCashSettlementCommandEvent';

/**
 * The payee of a payment in cash records it: a member of the group who received it from another member, in the group's currency
 * (`amount`) or in another one (`original`, request 39), converted at the rate the rates service offers for the UTC day it is
 * decided on. The book of the group decides it on the balances as they are in this transaction (GroupBalances, ADR 7), and refuses
 * it when it pays more than is owed; a book changed since it was read is re-read and decided again (CONC-OPTIMISTIC). For anyone who
 * is not a member of the group, the group does not exist. The result is the settlement's id.
 */
export class RecordCashSettlementCommandHandler extends CommandHandler<RecordCashSettlementCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly balances: IGroupBalances,
    private readonly members: ISettlementMembers,
    private readonly currencies: IGroupCurrency,
    private readonly rates: ISettlementRates,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    { payload }: RecordCashSettlementCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string }>> {
    const payee = requireSignedIn(context, 'Settlements');
    if (payee.isFailure()) return payee;

    const members = await this.members.currentMembers(payload.groupId);
    if (!members.includes(payee.data.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    }
    const groupArchived = await this.members.isArchived(payload.groupId);
    const callerSuspended = await this.members.isSuspended(payee.data.value);
    const at = this.clock();

    let original: OtherCurrencyPayment | undefined;
    if (payload.original !== undefined) {
      const groupCurrency = await this.currencies.currencyOf(payload.groupId);
      if (groupCurrency === null) return Result.fail(new NotFoundException('Settlements', 'Group not found'));
      original = {
        currency: payload.original.currency,
        amount: payload.original.amount,
        groupCurrency,
        offer: await offerForPayment({ currency: payload.original.currency, groupCurrency, at }, this.rates),
      };
    }

    const book = await this.books.findByGroup(new Id(payload.groupId));
    const balances = await this.balances.balancesOf(payload.groupId);
    const recorded = book.recordCash({
      payer: new Id(payload.from),
      payee: payee.data,
      amount: payload.amount,
      original,
      balances,
      members,
      groupArchived,
      callerSuspended,
      at,
    });
    if (recorded.isFailure()) return recorded;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok({ id: recorded.data.id.value });
  }
}
