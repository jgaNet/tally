import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';

import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';

/**
 * Tells the other contexts two groups were merged (GroupsMerged, the published language): the group kept and the group merged, by id. Ledger
 * and Settlements move what they hold in a reaction of their own; the integration event is made durable in this reaction's transaction and
 * published from the outbox after the commit (ADR 9, ADR 22).
 */
export class GroupsMergedHandler extends EventHandler<GroupsMergedEvent> {
  async execute({ payload }: GroupsMergedEvent, context: ExecutionContext): Promise<IResult<void>> {
    await publishIntegrationEvent(
      GroupsMergedIntegrationEvent.set({ keptGroupId: payload.groupId, mergedGroupId: payload.mergedGroupId }),
      context,
    );
    return Result.ok();
  }
}
