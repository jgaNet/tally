import { StatementLine } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';

export interface IStatementQueries {
  /**
   * The expenses of a group that a member paid or is in the split of, not deleted, the earliest date first and, on the
   * same date, the earliest recorded first (an edit does not change when it was recorded). Each line carries what the
   * member paid and their share, 0 where they paid or are not in the split; the balance is the caller's to count.
   */
  entriesOf(groupId: string, memberId: string): Promise<StatementLine[]>;
}
