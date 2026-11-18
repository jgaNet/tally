import { EventHandler, publishIntegrationEvent } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/**
 * Tells the other contexts that two groups were merged (request 31, docs/adr/0031): the domain event, made durable with the merge,
 * becomes the published fact `GroupsMerged`, which leaves through the outbox after this reaction commits. Groups knows nothing of
 * what Ledger and Settlements move.
 */
export class GroupsMergedHandler extends EventHandler<GroupsMergedEvent> {
  async execute({ payload }: GroupsMergedEvent, context: ExecutionContext) {
    const { keptGroupId, mergedGroupId } = payload;
    await publishIntegrationEvent(GroupsMergedIntegrationEvent.set({ keptGroupId, mergedGroupId }), context);
    return Result.ok(undefined);
  }
}
