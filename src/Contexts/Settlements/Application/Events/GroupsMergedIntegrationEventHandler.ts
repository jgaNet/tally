import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';

/**
 * Settlements' reaction to a merge (request 31, ADR 21): the settlements of the group merged are the group kept's. Its book is taken
 * up by the group kept's, in this reaction's own transaction, with the settlements' ids, statuses, histories and payments as they
 * were, so a payment that the provider reports after the merge is counted once, in the group kept. A group merged with no settlement
 * has no book, and nothing moves.
 */
export class GroupsMergedIntegrationEventHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(private books: ISettlementBookRepository) {
    super();
  }

  async execute({ payload }: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult> {
    const merged = await this.books.findByGroupId(payload.mergedGroupId);
    if (!merged) return Result.ok();

    const kept = (await this.books.findByGroupId(payload.keptGroupId)) ?? SettlementBook.open(payload.keptGroupId);
    kept.absorb(merged);
    const saved = await this.books.absorb(kept, merged);
    if (saved.isFailure()) return Result.fail(saved.error);

    await publishDomainEvents(kept, context);
    return Result.ok();
  }
}
