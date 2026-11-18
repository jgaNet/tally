/**
 * The audit entries Ledger keeps for a group, moved when the group is merged into another (request 31). An entry is never
 * changed, only the group it belongs to: the group kept reads it at its place in time, as the audit reads every entry.
 */
export interface IAuditEntries {
  /** Moves every audit entry of the group merged to the group kept, in the transaction of the merge's reaction. */
  moveGroup(mergedGroupId: string, keptGroupId: string): Promise<void>;
}
