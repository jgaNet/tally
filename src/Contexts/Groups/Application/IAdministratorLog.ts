import { AdministratorLogEntry } from '@Contexts/Groups/Domain/Account/AdministratorLogEntry';

import { AdministratorDecision } from './IAdministratorDecisions';

/**
 * The entries of the administrators' log that Groups writes itself (request 34): a suspension or a reinstatement, written in the same transaction
 * as the change it records, and read back by `GetAdministratorsLog` beside the decisions Settlements writes (ADR 32).
 */
export interface IAdministratorLog {
  /** Writes one entry; the caller's transaction makes it part of the change it records. */
  record(entry: AdministratorLogEntry): Promise<void>;
  /** Every entry Groups wrote, the oldest first. */
  entries(): Promise<AdministratorDecision[]>;
}
