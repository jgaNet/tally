import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

/** A group was merged into another (request 31, ADR 23): the group kept, the group merged, and when. */
export interface GroupsMergedPayload {
  groupId: string;
  mergedGroupId: string;
  mergedAt: string;
}

/**
 * Published by Groups once a group is merged into another, through the outbox; Ledger moves the expenses, the recurring
 * expenses and the audit of the group merged into the group kept, and Settlements its settlements, each in a reaction of its own.
 */
export class GroupsMergedIntegrationEvent extends IntegrationEvent<GroupsMergedPayload> {}
