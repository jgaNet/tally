import { IResult } from '@Architecture/Domain';

import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

/**
 * The debt watches, as aggregates: one per member and group (ADR 10). It loads and saves them, and answers the facts the sweep
 * needs about the collection: the members whose debt is noted now. A save is refused with a ConcurrencyConflictException when
 * the watch is no longer at the version it was read at (CONC-OPTIMISTIC).
 */
export interface IDebtWatchRepository {
  /** The watch of the member in the group, or null when none was ever kept for them. */
  findBy(groupId: string, memberId: string): Promise<DebtWatch | null>;
  /** The members whose debt is noted now: each one the run that last saw them owing more than 2000 noted, and none has cleared. */
  notedMembers(): Promise<{ groupId: string; memberId: string }[]>;
  save(watch: DebtWatch): Promise<IResult>;
}
