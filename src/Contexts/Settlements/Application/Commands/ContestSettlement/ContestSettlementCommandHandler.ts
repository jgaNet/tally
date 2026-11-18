import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ContestSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/ContestSettlement/ContestSettlementCommandEvent';

/**
 * Contesting a settlement (request 33): the payee of a settlement paid through the provider says the money did not reach them. The
 * book decides, against who asks, the status, whether it was contested before and the membership of both members; the settlement
 * is then contested, the balances stop counting it, and it waits for an administrator. To anyone who is not a member of its group
 * the settlement does not exist. The book is saved and what it recorded is published with the save, in one transaction.
 */
export class ContestSettlementCommandHandler extends CommandHandler<ContestSettlementCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private books: ISettlementBookRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: ContestSettlementCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const asker = caller.data.value;

    const { settlementId } = event.payload;
    const book = await this.books.findBySettlementId(settlementId);
    if (!book) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const members = await this.settlementMembers.membersOf(book.groupId, asker);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));
    if (await this.settlementMembers.isArchived(book.groupId)) return Result.fail(new GroupArchivedException());

    const contested = book.contest(
      { settlementId, asker, members: members.map(member => member.memberId) },
      this.clock(),
    );
    if (contested.isFailure()) return Result.fail(contested.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(settlementId);
  }
}
