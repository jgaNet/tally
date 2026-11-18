import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SetFeePolicyCommandEvent } from '@Contexts/Settlements/Application/Commands/SetFeePolicy/SetFeePolicyCommandEvent';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';

/**
 * A signed-in member asks to say who bears the provider's fee of the group's payments (request 38). For anyone who is not a member the
 * group does not exist. The owner's role is read inside the command's transaction, through the port Settlements owns (ADR 6); the book
 * decides: only the owner may change it, in a group that is not archived, and the payee bears it until then. A book opened here is kept at
 * version 1 with the policy alone, as a group's first settlement would open it.
 */
export class SetFeePolicyCommandHandler extends CommandHandler<SetFeePolicyCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private members: ISettlementMembers,
  ) {
    super();
  }

  async execute({ payload }: SetFeePolicyCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const members = await this.members.membersOf(payload.groupId);
    if (!members.includes(caller.data.value)) return Result.fail(notFound(payload.groupId));
    const role = await this.members.roleOf(payload.groupId, caller.data.value);
    const archived = await this.members.archivedOf(payload.groupId);
    const suspended = await this.members.suspendedOf(caller.data.value);

    const book =
      (await this.books.findByGroupId(new Id(payload.groupId))) ?? SettlementBook.open(new Id(payload.groupId));
    const changed = book.setFeePolicy({
      owner: role === 'owner',
      borneBy: payload.borneBy,
      archived,
      suspended,
    });
    if (changed.isFailure()) return changed;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(book, context);
    return Result.ok();
  }
}

const notFound = (id: string) => new NotFoundException('Settlements', 'Group not found', { id });
