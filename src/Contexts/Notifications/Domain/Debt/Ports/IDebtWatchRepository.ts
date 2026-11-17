import { Id, IResult } from '@Architecture/Domain';
import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';

/** A member of a group whose debt is noted now, by the ids of the group and the member. */
export interface NotedDebt {
  groupId: string;
  memberId: string;
}

export interface IDebtWatchRepository {
  /** The watch of a member in a group, read in the sweep's transaction, or null when none was ever kept for them. */
  findByMember(groupId: Id, memberId: Id): Promise<DebtWatch | null>;
  /** Stores a new watch, or a changed one, in the transaction it is made in; refuses one no longer at the stored version. */
  save(watch: DebtWatch): Promise<IResult>;
  /** The members whose debt is noted now, so that a member no longer owing is cleared even when no one owes them anything. */
  notedMembers(): Promise<NotedDebt[]>;
}
