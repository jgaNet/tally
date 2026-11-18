/** What an administrator did to an account (feature 34, request 34): suspended it, or reinstated it. */
export type AccountAction = 'suspended' | 'reinstated';

/**
 * One entry of the administrators' log that Groups writes (request 34): an administrator suspended or reinstated an account, `subjectId` being
 * the account. It is written in the transaction of the change, so an entry exists exactly for each change made.
 */
export interface AccountActionEntry {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly action: AccountAction;
  readonly subjectId: string;
}

/**
 * Groups' own part of the administrators' log (request 34, ADR 29): `record` writes an entry in the transaction of the change, and `actions`
 * reads every entry, the oldest first. The log Groups answers is these entries and Settlements' decisions (request 33), in the order made.
 */
export interface IAdministratorActionLog {
  record(entry: AccountActionEntry): Promise<void>;
  actions(): Promise<AccountActionEntry[]>;
}
