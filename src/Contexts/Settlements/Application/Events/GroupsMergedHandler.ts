import { IResult, Result } from '@Architecture/Domain';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { ISettlementBooks } from '@Contexts/Settlements/Application/ISettlementBooks';

/**
 * The reaction to Groups' `GroupsMerged` (request 31, ADR 28): the settlements of the group merged are taken into the group kept's settlement
 * book, each with its status and history, in one transaction of the reaction's own, and the book records `SettlementBookMerged` once it is moved.
 */
export class GroupsMergedIntegrationEventHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(private readonly books: ISettlementBooks) {
    super();
  }

  async execute(event: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, mergedGroupId } = event.payload;
    await this.books.inTransaction(async () => {
      const book = await this.books.bookOf(groupId);
      book.absorb(mergedGroupId);
      await this.books.absorb(book, mergedGroupId);
      await publishDomainEvents(book, context);
    });
    return Result.ok(undefined);
  }
}
