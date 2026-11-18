import { IntegrationEvent } from '@Architecture/Domain';

/** The payload of GroupsMerged, version 1 (conventions/integration-events.yaml): a group was merged into another one (feature 31). */
export interface GroupsMergedIntegrationPayload {
  /** The group kept: the one the other's expenses, settlements and recurring expenses are moved to. */
  readonly keptGroupId: string;
  /** The group merged: gone once the fact is made, and its expenses, settlements and recurring expenses are the group kept's. */
  readonly mergedGroupId: string;
  /** When the merge was made, ISO 8601. */
  readonly at: string;
}

/**
 * GroupsMerged: a group was merged into another one of the same currency by its owner (request 31). Groups publishes it through the
 * outbox after the merge commits; Ledger and Settlements each move what the group merged held to the group kept, in a reaction of their own.
 */
export class GroupsMergedIntegrationEvent extends IntegrationEvent<GroupsMergedIntegrationPayload> {}
