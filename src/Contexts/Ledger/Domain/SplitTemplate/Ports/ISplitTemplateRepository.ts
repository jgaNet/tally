import { IResult } from '@Architecture/Domain';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/** The store of split templates as aggregates: loads, saves and deletes one. It never searches for a screen; that is the queries. */
export interface ISplitTemplateRepository {
  /** The template with the id, or null when there is none. */
  findById(id: string): Promise<SplitTemplate | null>;
  /** The template of a group with the name, whatever its case, or null: the fact a name's being free is decided on (request 25). */
  findByName(groupId: string, name: string): Promise<SplitTemplate | null>;
  /**
   * Stores a template: a new one at version 1, or one changed at the version it was read at plus one. A template no longer at
   * the stored version is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC); a name another template of the group
   * has is refused with a DuplicateTemplateNameException.
   */
  save(template: SplitTemplate): Promise<IResult>;
  /** Erases a template at the version it was read at; one no longer at it is refused with a ConcurrencyConflictException. */
  erase(template: SplitTemplate): Promise<IResult>;
}
