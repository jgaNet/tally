import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { SetFeePolicyCommandEvent } from '@Contexts/Settlements/Application/Commands/SetFeePolicy/SetFeePolicyCommandEvent';

/**
 * The owner of a group decides who bears the provider's fee (request 38): payer, payee or shared. Only the owner may; any other
 * member is refused, a non-member is told the group does not exist, and an archived group or a suspended caller writes nothing.
 * The book is saved and what it recorded is published with the save, in one transaction; its answer is the group's id.
 */
export class SetFeePolicyCommandHandler extends CommandHandler<SetFeePolicyCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private books: ISettlementBookRepository,
  ) {
    super();
  }

  async execute(event: SetFeePolicyCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const asker = caller.data.value;

    const { groupId, borneBy } = event.payload;
    if (!(await this.settlementMembers.membersOf(groupId, asker))) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    }
    if (await this.settlementMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    if (await this.settlementMembers.isSuspended(asker)) return Result.fail(new AccountSuspendedException());
    const owner = await this.settlementMembers.ownerOf(groupId, asker);
    if (owner === null) return Result.fail(new NotFoundException('Settlements', 'Group not found'));

    const book = (await this.books.findByGroupId(groupId)) ?? SettlementBook.open(groupId);
    const set = book.setFeePolicy({ borneBy, asker, owner });
    if (set.isFailure()) return Result.fail(set.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(groupId);
  }
}
