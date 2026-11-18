import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RecordCashSettlement/RecordCashSettlementCommandEvent';

/**
 * The payee of a payment in cash records it: a member of the group who received `amount` from another member. The book of
 * the group decides it on the balances as they are in this transaction (GroupBalances, ADR 7), and refuses it when it pays
 * more than is owed; a book changed since it was read is re-read and decided again (CONC-OPTIMISTIC). For anyone who is not
 * a member of the group, the group does not exist. The result is the settlement's id.
 */
export class RecordCashSettlementCommandHandler extends CommandHandler<RecordCashSettlementCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly balances: IGroupBalances,
    private readonly members: ISettlementMembers,
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

    const book = await this.books.findByGroup(new Id(payload.groupId));
    const balances = await this.balances.balancesOf(payload.groupId);
    const recorded = book.recordCash({
      payer: new Id(payload.from),
      payee: payee.data,
      amount: payload.amount,
      balances,
      members,
      groupArchived,
      at: this.clock(),
    });
    if (recorded.isFailure()) return recorded;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok({ id: recorded.data.id.value });
  }
}
