import { Id, IResult } from '@Architecture/Domain';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

export interface ISplitTemplateRepository {
  /** The template under this id, or null. */
  findById(id: Id): Promise<SplitTemplate | null>;
  /**
   * Whether the group has a template of this name, whatever its case, other than the template `except` (request 25): a name is free in its
   * group. Read by a command outside any lock; the save that follows is in the same transaction.
   */
  nameTaken(groupId: Id, name: string, except: Id | null): Promise<boolean>;
  /** Stores a new template, or one changed at its version + 1; a version it was not read at is a ConcurrencyConflict. */
  save(template: SplitTemplate): Promise<IResult>;
  /** Removes the template, if it is still at the version it was read at (else a ConcurrencyConflict). */
  remove(template: SplitTemplate): Promise<IResult>;
  /** Drops the split templates of a group: a group merged into another loses its templates (request 31). */
  dropGroup(groupId: Id): Promise<void>;
}
