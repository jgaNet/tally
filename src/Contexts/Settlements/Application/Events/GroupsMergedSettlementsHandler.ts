import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';

/**
 * Moves the settlements of a group merged into the group kept (request 31, ADR 23): the book kept takes the book merged's, in
 * one transaction, both books at their version + 1, so a settlement decided at once in either re-reads them. Groups refused the
 * merge while a payment waited at the provider in the group merged, so none moves pending or refunding. SettlementBookMerged.
 */
export class GroupsMergedSettlementsHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const kept = await this.books.findByGroup(new Id(event.payload.groupId));
    const merged = await this.books.findByGroup(new Id(event.payload.mergedGroupId));
    kept.absorb(merged, this.clock());

    const emptied = await this.books.save(merged);
    if (emptied.isFailure()) return emptied;
    const saved = await this.books.save(kept);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(kept, context);
    return Result.ok();
  }
}
