import { EventHandler, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';

/**
 * Moves what Settlements holds of a merged group to the group kept (request 31, docs/adr/0031), in a reaction of its own: the group kept's
 * book takes the settlements of the group merged, with their ids, statuses and histories, and their audit, and the group merged's book is
 * gone. The book of the group kept is saved one version on, in the same transaction, so a settlement decided on it at the same moment is
 * refused rather than lost. The fact reaches here once (the outbox and the bus's inbox).
 */
export class GroupsMergedIntegrationHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(private readonly books: ISettlementBooks) {
    super();
  }

  async execute({ payload }: GroupsMergedIntegrationEvent, context: ExecutionContext) {
    const { keptGroupId, mergedGroupId } = payload;
    const book = await this.books.get(keptGroupId);
    book.absorb(mergedGroupId);
    await this.books.moveGroup(mergedGroupId, keptGroupId);
    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok(undefined);
  }
}
