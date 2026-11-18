import { EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';

import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';

import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * Moves the settlements of the group merged into the group kept (request 31), in a reaction of its own: the group kept's book takes up the
 * merged group's settlements and their audit, and the merged book is gone when the book is saved (ADR 22). A group that had no book has
 * nothing to move. The zero sum holds while Ledger's reaction runs: a settlement moves as much up as down.
 */
export class GroupsMergedIntegrationEventHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(private books: ISettlementBookRepository) {
    super();
  }

  async execute({ payload }: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const merged = await this.books.findByGroupId(new Id(payload.mergedGroupId));
    if (!merged) return Result.ok();

    const kept =
      (await this.books.findByGroupId(new Id(payload.keptGroupId))) ?? SettlementBook.open(new Id(payload.keptGroupId));
    const absorbed = kept.absorb(new Id(payload.mergedGroupId));
    if (absorbed.isFailure()) return absorbed;

    const saved = await this.books.save(kept);
    if (saved.isFailure()) return saved;

    await publishDomainEvents(kept, context);
    return Result.ok();
  }
}
