import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/**
 * Where a merge leaves Groups (request 31, ADR 21): the domain event, Groups' own words, is restated as the published
 * GroupsMerged, through the outbox when this reaction's transaction commits. Ledger and Settlements move what they hold of the
 * group merged; Groups knows nothing of how they do it.
 */
export class GroupsMergedHandler extends EventHandler<GroupsMergedEvent> {
  async execute({ payload }: GroupsMergedEvent, context: ExecutionContext): Promise<IResult> {
    await publishIntegrationEvent(
      GroupsMergedIntegrationEvent.set({ keptGroupId: payload.groupId, mergedGroupId: payload.mergedGroupId }),
      context,
    );
    return Result.ok();
  }
}
