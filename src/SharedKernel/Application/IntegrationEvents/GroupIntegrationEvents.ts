import { IntegrationEvent } from '@Architecture/Domain';

/**
 * Two groups were merged (request 31, docs/adr/0031): Groups' fact, in its public words. The group merged is gone once it is told; what it
 * held is the group kept's within seconds. It carries the two ids and never asks back: Ledger moves the expenses, recurring expenses and
 * audit entries of the group merged, and Settlements its settlements, each in a reaction of its own.
 */
export class GroupsMergedIntegrationEvent extends IntegrationEvent<{
  keptGroupId: string;
  mergedGroupId: string;
}> {}
