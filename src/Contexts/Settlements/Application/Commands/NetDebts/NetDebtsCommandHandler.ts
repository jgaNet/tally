import { IResult, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { AccountDeletedException, AccountSuspendedException } from '@SharedKernel/Domain';

import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { INettingRepository } from '@Contexts/Settlements/Domain/Netting/Ports/INettingRepository';
import { NetDebts, NettingGroup } from '@Contexts/Settlements/Domain/Netting/NetDebts';
import { NetDebtsCommandEvent } from '@Contexts/Settlements/Application/Commands/NetDebts/NetDebtsCommandEvent';

/**
 * Netting what two people owe each other across their groups (request 32): the signed-in caller asks, with another account. The
 * groups they share in the currency, not archived, are read in the order they were created, each with its book, its members and
 * its balances, and `NetDebts` decides the amount and the settlements (paid at once, method `net`). The books that moved and the
 * netting are saved in one transaction; a conflict on any of them decides the whole again, through the base handler. Its answer is
 * the netting's id.
 */
export class NetDebtsCommandHandler extends CommandHandler<NetDebtsCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private balances: IGroupBalances,
    private books: ISettlementBookRepository,
    private nettings: INettingRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: NetDebtsCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const by = caller.data.value;
    // A suspended account nets nothing, with anyone (request 34).
    if (await this.settlementMembers.isSuspended(by)) return Result.fail(new AccountSuspendedException());
    const { with: other, currency } = event.payload;
    // A deleted account is netted with by no one (request 35).
    if (await this.settlementMembers.isDeleted(other)) return Result.fail(new AccountDeletedException());

    const groups: NettingGroup[] = [];
    for (const shared of await this.settlementMembers.groupsSharedBy(by, other)) {
      if (shared.archived || shared.currency !== currency) continue;
      const members = await this.settlementMembers.membersOf(shared.groupId, by);
      if (!members) continue;

      const book = (await this.books.findByGroupId(shared.groupId)) ?? SettlementBook.open(shared.groupId);
      const balances = await this.balances.balancesOf(shared.groupId);
      groups.push({ groupId: shared.groupId, book, members: members.map(member => member.memberId), balances });
    }

    const netting = NetDebts.between({ by, other, currency, groups, at: this.clock() });
    if (netting.isFailure()) return Result.fail(netting.error);

    const moved = groups.filter(group => group.book.hasChanges()).map(group => group.book);
    for (const book of moved) {
      const saved = await this.books.save(book);
      if (saved.isFailure()) return Result.fail(saved.error);
    }
    await this.nettings.save(netting.data);

    for (const book of moved) await publishDomainEvents(book, context);
    await publishDomainEvents(netting.data, context);
    return Result.ok(netting.data._id.value);
  }
}
