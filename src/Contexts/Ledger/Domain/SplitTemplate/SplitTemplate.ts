import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SplitTemplateSnapshot, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import {
  TemplateRemovedEvent,
  TemplateReplacedEvent,
  TemplateSavedEvent,
} from '@Contexts/Ledger/Domain/SplitTemplate/Events/SplitTemplateEvents';
import {
  InvalidTemplateSplitException,
  TemplateNameTakenException,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';
import { SplitTemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateName';

/**
 * A split saved under a name by a member of a group, which an expense is split by in place of its own (request 25, docs/adr/0024).
 * One aggregate per template. It keeps its split as it was given: between the members listed, equally, or by whole shares. The members
 * it names are the group's when it is saved or replaced; an expense checks them again when it is split by it (the Expense decides, as for
 * any split), so a template whose member has left is kept and splits nothing.
 *
 * `create()` is the creation: it validates the name and the split, and records `TemplateSaved`. `nameIsFree` is the fact the store
 * answered about the group's templates, the name being unique in its group whatever its case. `replace()` and `delete()` are for the member
 * who saved the template and the group's owner, and no one else. `asSplitInput()` is the split an expense takes when it is split by this
 * template: the same one, as if it had been given. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data.
 *
 * The version is the one the aggregate was read at, which the store checks when it saves or removes it (CONC-OPTIMISTIC); the aggregate
 * never changes it.
 */
export class SplitTemplate extends AggregateRoot {
  readonly #groupId: string;
  readonly #name: SplitTemplateName;
  readonly #createdBy: string;
  readonly #split: TemplateSplit;

  private constructor(
    id: Id,
    groupId: string,
    name: SplitTemplateName,
    createdBy: string,
    split: TemplateSplit,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#name = name;
    this.#createdBy = createdBy;
    this.#split = split;
  }

  /** Saves a split under a name, by a member of the group (`by`, one of `members`, the group's current ones). */
  static create({
    groupId,
    name,
    split,
    by,
    members,
    nameIsFree,
  }: {
    groupId: string;
    name: string;
    split: TemplateSplit;
    by: string;
    members: GroupMember[];
    nameIsFree: boolean;
  }): IResult<SplitTemplate> {
    const checked = checkTemplate({ name, split, members, nameIsFree });
    if (checked.isFailure()) return checked;

    const id = Id.generate();
    const template = new SplitTemplate(id, groupId, checked.data.name, by, checked.data.split, 0);
    template.record(
      TemplateSavedEvent.set({
        templateId: id.value,
        groupId,
        name: checked.data.name.value,
        createdBy: by,
      }),
    );
    return Result.ok(template);
  }

  /** Replaces the name and the split, for the member who saved it or the group's owner; any other member is refused (request 25). */
  replace({
    by,
    members,
    name,
    split,
    nameIsFree,
  }: {
    by: string;
    members: GroupMember[];
    name: string;
    split: TemplateSplit;
    nameIsFree: boolean;
  }): IResult<SplitTemplate> {
    if (!this.mayChange(by, members)) return Result.fail(notAllowedToChange());
    const checked = checkTemplate({ name, split, members, nameIsFree });
    if (checked.isFailure()) return checked;

    const replaced = new SplitTemplate(
      this._id,
      this.#groupId,
      checked.data.name,
      this.#createdBy,
      checked.data.split,
      this.version,
    );
    replaced.record(
      TemplateReplacedEvent.set({
        templateId: this._id.value,
        groupId: this.#groupId,
        name: checked.data.name.value,
      }),
    );
    return Result.ok(replaced);
  }

  /** Removes the template, for the member who saved it or the group's owner; any other member is refused (request 25). */
  delete({ by, members }: { by: string; members: GroupMember[] }): IResult<SplitTemplate> {
    if (!this.mayChange(by, members)) return Result.fail(notAllowedToChange());
    this.record(TemplateRemovedEvent.set({ templateId: this._id.value, groupId: this.#groupId }));
    return Result.ok(this);
  }

  /** The split an expense takes when it is split by this template: the one it was saved with, as if it had been given (request 25). */
  asSplitInput(): SplitInput {
    return copySplit(this.#split);
  }

  static fromSnapshot(snapshot: SplitTemplateSnapshot): SplitTemplate {
    const name = SplitTemplateName.create(snapshot.name);
    if (!snapshot.id || name.isFailure() || !isWellFormed(snapshot.split)) {
      throw new Error(`The split template ${snapshot.id} is corrupted in the store`);
    }
    return new SplitTemplate(
      new Id(snapshot.id),
      snapshot.groupId,
      name.data,
      snapshot.createdBy,
      copySplit(snapshot.split),
      snapshot.version,
    );
  }

  toSnapshot(): SplitTemplateSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      name: this.#name.value,
      createdBy: this.#createdBy,
      split: copySplit(this.#split),
      version: this.version,
    };
  }

  get id(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  get name(): string {
    return this.#name.value;
  }

  get createdBy(): string {
    return this.#createdBy;
  }

  get split(): TemplateSplit {
    return copySplit(this.#split);
  }

  /** The member who saved the template, or the group's owner, may change it; any other member may not. */
  private mayChange(by: string, members: GroupMember[]): boolean {
    if (by === this.#createdBy) return true;
    return members.some(member => member.memberId === by && member.role === 'owner');
  }
}

/**
 * The rules of a template as it is given, shared by its saving and its replacing: a name of 1 to 60 characters, and a split between one or
 * more of the group's current members, each listed once, each with at least 1 share; the name must be free in the group.
 */
function checkTemplate({
  name,
  split,
  members,
  nameIsFree,
}: {
  name: string;
  split: TemplateSplit;
  members: GroupMember[];
  nameIsFree: boolean;
}): IResult<{ name: SplitTemplateName; split: TemplateSplit }> {
  const text = SplitTemplateName.create(name);
  if (text.isFailure()) return text;
  if (!isWellFormed(split) || !listedAreCurrentMembers(split, members)) {
    return Result.fail(new InvalidTemplateSplitException());
  }
  if (!nameIsFree) return Result.fail(new TemplateNameTakenException());
  return Result.ok({ name: text.data, split: copySplit(split) });
}

/** Whether the split names one or more members, each once, and every share is a whole number of 1 or more. */
function isWellFormed(split: TemplateSplit): boolean {
  const listed = listedMembersOf(split);
  if (listed.length === 0 || new Set(listed).size !== listed.length) return false;
  if (split.kind === 'shares') {
    return split.shares.every(({ shares }) => Number.isInteger(shares) && shares >= 1);
  }
  return true;
}

/** Whether every member the split names is a current member of the group. */
function listedAreCurrentMembers(split: TemplateSplit, members: GroupMember[]): boolean {
  const current = new Set(members.map(member => member.memberId));
  return listedMembersOf(split).every(memberId => current.has(memberId));
}

function listedMembersOf(split: TemplateSplit): string[] {
  return split.kind === 'equal' ? split.between : split.shares.map(({ memberId }) => memberId);
}

function copySplit(split: TemplateSplit): TemplateSplit {
  return split.kind === 'equal'
    ? { kind: 'equal', between: [...split.between] }
    : { kind: 'shares', shares: split.shares.map(share => ({ ...share })) };
}

const notAllowedToChange = () =>
  new NotAllowedException('Ledger', "Only the member who saved a template or the group's owner may change it");
