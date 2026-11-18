import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';

import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Group';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

/**
 * Tells the other contexts a group was merged into another one (GroupsMerged, the published language, feature 31): the domain event of the
 * merge, translated into the integration event, which is made durable in this reaction's transaction and published after it commits. Ledger
 * and Settlements each move what the group merged held, in a reaction of their own.
 */
export class PublishGroupsMergedHandler extends EventHandler<GroupsMergedEvent> {
  async execute(event: GroupsMergedEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { keptGroupId, mergedGroupId, at } = event.payload;
    await publishIntegrationEvent(GroupsMergedIntegrationEvent.set({ keptGroupId, mergedGroupId, at }), context);
    return Result.ok(undefined);
  }
}
