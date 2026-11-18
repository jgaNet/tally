/**
 * What a merged group keeps in Ledger's tables, other than its expenses and recurring expenses (request 31, docs/adr/0031): the group's
 * audit entries and its receipts move to the group kept, with the seq they were made in; its monthly budgets and split templates are dropped
 * with it, since the group kept's are the ones that hold. Used inside a transaction only.
 */
export interface IMergedGroupRecords {
  moveGroup(fromGroupId: string, intoGroupId: string): Promise<void>;
}
