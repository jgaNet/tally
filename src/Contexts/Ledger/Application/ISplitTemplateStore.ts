import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/**
 * A template as a member of its group reads it: its id, group and name, and its split as it was given, either `splitBetween` (the members
 * of an equal split, in the order given) or `splitByShares` (each member with their shares). Never the aggregate (QUERY-READ-MODELS).
 */
export interface TemplateView {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly splitBetween?: string[];
  readonly splitByShares?: { memberId: string; shares: number }[];
}

/**
 * The store of split templates (request 25), the port the use cases and the expenses write and read through. `findById` loads a template as the
 * aggregate it was last saved as, or `undefined` when there is none; `nameHeldBy` answers the id of the template of a group that holds a name,
 * whatever its case, or `undefined` when none does (a fact the save and the replacement decide on); `add` keeps a new template, and `save` and
 * `remove` keep or take out one only while it is still at the version it was loaded at, and refuse it with a ConcurrencyConflictException
 * otherwise (ADR 8); `listOf` answers a group's templates, the earliest saved first, each as a read model.
 */
export interface ISplitTemplateStore {
  findById(templateId: string): Promise<SplitTemplate | undefined>;
  nameHeldBy(groupId: string, name: string): Promise<string | undefined>;
  add(template: SplitTemplate): Promise<void>;
  save(template: SplitTemplate): Promise<void>;
  remove(template: SplitTemplate): Promise<void>;
  listOf(groupId: string): Promise<TemplateView[]>;
}
