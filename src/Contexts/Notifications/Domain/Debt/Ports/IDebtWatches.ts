import { IResult } from '@Architecture/Domain';

import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';

/** The store of the debt watches: used inside the sweep's transaction only (docs/adr/0018). */
export interface IDebtWatches {
  /** The member's watch in the group, as last saved; a member never watched is a watch not yet opened (version 0). */
  get(accountId: string, groupId: string): Promise<DebtWatch>;
  /**
   * Saves the watch at the version it was read at. A watch another server saved meanwhile answers a conflict, and the sweep re-reads and
   * decides again: two servers on one database remind a member at most once a period (CONC-OPTIMISTIC).
   */
  save(watch: DebtWatch): Promise<IResult<undefined>>;
}

/** The read side of the watches: which debts the sweep has noted, so that one that cleared is cleared even when nobody owes it now. */
export interface IDebtWatchQueries {
  /** Every member and group whose debt is noted at the moment. */
  noted(): Promise<Array<{ accountId: string; groupId: string }>>;
}
