import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

export interface GroupsMergedPayload {
  /** The group kept: the one the other group's members, expenses, settlements and audit are moved into. */
  keptGroupId: string;
  /** The group merged: gone once the merge is done, its contents the group kept's (request 31). */
  mergedGroupId: string;
}

/**
 * Published by Groups when the owner of two groups merges one into the other (request 31, ADR 21): the group kept and the
 * group merged, so that Ledger and Settlements move what each holds of the group merged into the group kept, each in a
 * reaction of its own. Everything a consumer needs, so it never asks Groups back.
 */
export class GroupsMergedIntegrationEvent extends IntegrationEvent<GroupsMergedPayload> {}
