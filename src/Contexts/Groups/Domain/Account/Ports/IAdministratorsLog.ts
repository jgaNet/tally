import { AdministratorDecision } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * The administrators' log as Groups keeps its own entries (request 34): an account suspended or reinstated. Groups writes an entry
 * in the transaction of the change it logs, and answers the log with it next to Settlements' entries (IAdministratorDecisions).
 */
export interface IAdministratorsLog {
  /** Stores an entry, in the transaction of the change it records. */
  record(entry: AdministratorDecision): Promise<void>;
}

/** Groups' own entries of the administrators' log, the oldest first, as the log reads them. */
export interface IAdministratorsLogQueries {
  all(): Promise<AdministratorDecision[]>;
}
