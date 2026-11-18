import { AdministratorDecision } from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';

/**
 * The administrators' log entries Groups writes for its own decisions (request 34): a suspension and a reinstatement, written by the command
 * in its transaction, with the change, and read back, oldest first, by the adapter that answers the log together with Settlements' entries.
 */
export interface IGroupAdministratorLog {
  record(entry: AdministratorDecision): Promise<void>;
  entries(): Promise<AdministratorDecision[]>;
}
