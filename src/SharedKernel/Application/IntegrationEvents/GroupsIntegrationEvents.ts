import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

/** The payload of GroupsMerged, as conventions/integration-events.yaml declares it (its last version). */
export interface GroupsMergedPayload {
  keptGroupId: string;
  mergedGroupId: string;
}

/** Two groups were merged (request 31): the group kept keeps everything, and the group merged is gone. */
export class GroupsMergedIntegrationEvent extends IntegrationEvent<GroupsMergedPayload> {}
