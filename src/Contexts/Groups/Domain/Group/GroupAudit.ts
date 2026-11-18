/**
 * The audit entry a leave writes (feature 28, request 28, ADR 23): the balance a member who left passed to the owner, when it is not 0, as
 * the member's own change. Written in the leave's transaction, and never changed.
 */
export interface GroupAuditEntry {
  readonly id: string;
  readonly groupId: string;
  readonly at: string;
  /** The member who left: the change is theirs. */
  readonly by: string;
  readonly action: 'balance-passed';
  readonly subjectId: string;
  /** The balance as they left it, positive or negative, in the group's currency's hundredths. */
  readonly amount: number;
}

/**
 * The identity of a pass's entry, born with the pass: a group's passes are numbered in the order they were made and never changed, so the
 * pass's place in its group identifies it (a member may leave, rejoin and leave again, so the member does not).
 */
export const balancePassedAuditId = (groupId: string, position: number): string =>
  `balance-passed:${groupId}:${position}`;
