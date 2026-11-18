import { IResult } from '@Architecture/Domain';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/**
 * The store of split templates: loads and saves whole aggregates inside a transaction only (request 25, docs/adr/0024). `findByName()`
 * is the fact the rule "two templates of a group never have the same name" needs about the collection.
 */
export interface ISplitTemplates {
  /** The template as it is stored, at the version it is at; undefined when there is no such template. */
  get(id: string): Promise<SplitTemplate | undefined>;
  /** The template of the group with the same name, whatever its case and its surrounding spaces; undefined when none has it. */
  findByName(groupId: string, name: string): Promise<SplitTemplate | undefined>;
  /** Stores a new template, or a changed one, if it is still at the version it was read at: a conflict otherwise (CONC-OPTIMISTIC). */
  save(template: SplitTemplate): Promise<IResult<undefined>>;
  /** Removes a template, if it is still at the version it was read at: a conflict otherwise (CONC-OPTIMISTIC). */
  delete(template: SplitTemplate): Promise<IResult<undefined>>;
}
