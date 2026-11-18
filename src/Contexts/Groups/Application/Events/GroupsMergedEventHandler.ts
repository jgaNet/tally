import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';
import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/**
 * Tells the other contexts that a group was merged into another (request 31, ADR 23): the domain event becomes the published
 * one, with the group kept, the group merged and when. Ledger and Settlements move what they hold of it, each in its own
 * transaction.
 */
export class GroupsMergedEventHandler extends EventHandler<GroupsMergedEvent> {
  async execute({ payload }: GroupsMergedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, mergedGroupId, mergedAt } = payload;
    await publishIntegrationEvent(GroupsMergedIntegrationEvent.set({ groupId, mergedGroupId, mergedAt }), context);
    return Result.ok();
  }
}
