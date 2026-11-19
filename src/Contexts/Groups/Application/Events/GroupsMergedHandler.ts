import { IResult, Result } from '@Architecture/Domain';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishIntegrationEvent } from '@Architecture/Application/DomainEvents';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';
import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/GroupEvents';

/**
 * The policy that tells the other contexts two groups were merged (request 31, ADR 28): it translates Groups' domain event into the published
 * `GroupsMerged`, through the outbox, in a transaction of its own. Ledger and Settlements each move what they hold in their own reaction.
 */
export class GroupsMergedHandler extends EventHandler<GroupsMergedEvent> {
  async execute(event: GroupsMergedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, mergedGroupId } = event.payload;
    await publishIntegrationEvent(GroupsMergedIntegrationEvent.set({ groupId, mergedGroupId }), context);
    return Result.ok(undefined);
  }
}
