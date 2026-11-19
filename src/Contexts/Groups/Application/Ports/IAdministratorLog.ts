import { AdministratorDecision } from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';

/** What an entry of the administrators' log says it did (request 33, request 34). */
export type AdministratorAction = AdministratorDecision['action'] | 'suspended' | 'reinstated';

/** One entry of the administrators' log: when, by which administrator, what, and about which subject (an account or a settlement). */
export interface AdministratorLogEntry {
  id: string;
  at: string;
  by: string;
  action: AdministratorAction;
  subjectId: string;
}

/**
 * The administrators' log of what Groups decides about accounts (request 34, ADR 25): kept in the transaction of each suspension
 * and reinstatement, and read back as Groups' own entries.
 */
export interface IAdministratorLog {
  /** Keeps an entry in the transaction the caller runs in; its id is given by the log. */
  record(entry: Omit<AdministratorLogEntry, 'id'>): Promise<void>;
  /** Groups' own entries, the oldest first. */
  entries(): Promise<AdministratorLogEntry[]>;
}

/** What the administrators' log is read from: Groups' own entries and Settlements' decisions, through Groups' port (AdministratorDecisions). */
export interface IAdministratorLogReads {
  decisions(): Promise<AdministratorLogEntry[]>;
  entries(): Promise<AdministratorLogEntry[]>;
}
