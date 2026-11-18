import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RecordCashSettlement/RecordCashSettlementCommandEvent';

/**
 * Recording a cash settlement (request 12): the signed-in member who received the money records who paid them and how much.
 * The members and the balances are asked when this decides: the book of the group decides the settlement against them,
 * in the same transaction as the book's version, so a second settlement recorded at the same moment is decided on the first
 * one's balances, or refused at the save and decided again (CONC-OPTIMISTIC, ADR 8). To anyone who is not a member the group
 * does not exist. The book is saved and what it recorded is published with the save, in one transaction. Its answer is the
 * settlement's id.
 */
export class RecordCashSettlementCommandHandler extends CommandHandler<RecordCashSettlementCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private balances: IGroupBalances,
    private books: ISettlementBookRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: RecordCashSettlementCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const payee = caller.data.value;

    const { groupId, from, amount } = event.payload;
    const members = await this.settlementMembers.membersOf(groupId, payee);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    if (await this.settlementMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());

    const balances = await this.balances.balancesOf(groupId);
    const book = (await this.books.findByGroupId(groupId)) ?? SettlementBook.open(groupId);

    const recorded = book.recordCash({
      payer: from,
      payee,
      amount,
      at: this.clock(),
      members: members.map(member => member.memberId),
      balances,
    });
    if (recorded.isFailure()) return Result.fail(recorded.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(recorded.data._id);
  }
}
