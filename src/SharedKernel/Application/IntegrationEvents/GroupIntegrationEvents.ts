import { IntegrationEvent } from '@Architecture/Domain';

/**
 * Two groups were merged (request 31), published by Groups (conventions/integration-events.yaml, ADR 28): `groupId` is the group kept,
 * `mergedGroupId` the group merged into it, which is gone. Ledger moves the expenses, recurring expenses and audit entries of the group
 * merged to the group kept, and Settlements its settlement book, each in a reaction of its own; nothing else reads it.
 */
export class GroupsMergedIntegrationEvent extends IntegrationEvent<{
  groupId: string;
  mergedGroupId: string;
}> {}
