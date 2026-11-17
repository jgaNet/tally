import { IResult } from '@Architecture/Domain';

import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

export interface IDebtWatchRepository {
  /** The watch of a member in a group, as the transaction reads it, or null when none was ever opened for them. */
  find(groupId: string, memberId: string): Promise<DebtWatch | null>;
  /** The watches with a debt noted now, in any group: the sweep clears the ones whose debt is gone. Read outside any transaction. */
  findNoted(): Promise<DebtWatch[]>;
  /**
   * Stores a watch at the version it was read at: a new one is inserted, an existing one is updated only while it is still at that
   * version. Otherwise the save is a ConcurrencyConflictException, and the sweep reads it again (ADR 10).
   */
  save(watch: DebtWatch): Promise<IResult>;
}
