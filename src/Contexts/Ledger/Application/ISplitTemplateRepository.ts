import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/**
 * The split templates, as aggregates, one per saved split, written whole. A template is loaded at the version it was stored at, and
 * written only over that version: a save or removal over a newer one is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export interface ISplitTemplateRepository {
  /** The template with this id, if it is stored. */
  get(id: string): Promise<SplitTemplate | undefined>;
  /**
   * Whether a template of the group has the name, whatever its case, other than the one `exceptId` names (request 25): the fact a saving
   * or a replacement is decided against.
   */
  isNameTaken(groupId: string, name: string, exceptId?: string): Promise<boolean>;
  /** Inserts the first version of a template saved in a group. */
  insert(template: SplitTemplate): Promise<void>;
  /** Writes a template replaced, over the version it was read at. */
  save(template: SplitTemplate): Promise<void>;
  /** Removes a template, over the version it was read at. */
  remove(template: SplitTemplate): Promise<void>;
  /** Runs `work` in one transaction on the store, so what it reads and writes is one state (ADR 17). */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
