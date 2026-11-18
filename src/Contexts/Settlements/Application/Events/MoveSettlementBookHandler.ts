import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementStore } from '@Contexts/Settlements/Application/ISettlementStore';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

/**
 * Moves the settlements of the group merged to the group kept (request 31, feature 31): the reaction to GroupsMerged, in its own transaction.
 * Each settlement keeps its id, its status and its history, and its audit entries follow it. The group kept's book is opened at its version,
 * which the move stores at its next one, as a settlement does; a group merged with no settlement has nothing to move and records nothing. A
 * second delivery finds nothing left in the group merged.
 */
export class MoveSettlementBookHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private readonly store: ISettlementStore,
    private readonly members: ISettlementMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { keptGroupId, mergedGroupId } = event.payload;
    const settlementIds = await this.store.settlementIdsOf(mergedGroupId);
    if (settlementIds.length === 0) return Result.ok(undefined);

    // The group kept is the one the book is of, and it has the currency the merge kept (request 2, request 31): a book is opened in it.
    const currency = await this.members.currencyOf(keptGroupId);
    if (currency === undefined) throw new Error(`The group kept by a merge is not there: ${keptGroupId}`);
    const book = SettlementBook.open({
      groupId: keptGroupId,
      currency,
      version: await this.store.versionOf(keptGroupId),
      members: [],
      balances: [],
    });
    book.absorb(mergedGroupId, settlementIds, this.clock());
    await this.store.absorb(book, mergedGroupId);
    await publishDomainEvents(book, context);
    return Result.ok(undefined);
  }
}
