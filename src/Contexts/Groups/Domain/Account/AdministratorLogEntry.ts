import { Id } from '@Architecture/Domain';

/** What an administrator did, in Groups' log (request 34): a suspension or a reinstatement of an account. */
export type AdministratorAction = 'suspended' | 'reinstated';

/** An entry of the administrators' log that Groups writes: who did what to which account, and when (request 34). */
export interface AdministratorLogEntrySnapshot {
  id: string;
  at: Date;
  by: string;
  action: AdministratorAction;
  subjectId: string;
}

/**
 * An entry of the administrators' log made by a suspension or a reinstatement (request 34, ADR 32). Its id is born here, once, as an
 * aggregate's is, and the entry is written in the same transaction as the change it records, so a change with no entry is not possible.
 */
export class AdministratorLogEntry {
  readonly #snapshot: AdministratorLogEntrySnapshot;

  private constructor(snapshot: AdministratorLogEntrySnapshot) {
    this.#snapshot = snapshot;
  }

  static of({ by, action, subjectId, at }: Omit<AdministratorLogEntrySnapshot, 'id'>): AdministratorLogEntry {
    return new AdministratorLogEntry({ id: Id.generate().value, at, by, action, subjectId });
  }

  toSnapshot(): AdministratorLogEntrySnapshot {
    return { ...this.#snapshot };
  }
}
