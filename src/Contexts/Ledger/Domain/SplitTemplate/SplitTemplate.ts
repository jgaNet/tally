import { AggregateRoot, Id } from '@Architecture/Domain';

import { TemplateRemovedEvent, TemplateReplacedEvent, TemplateSavedEvent } from './SplitTemplateEvents';
import { TemplateName } from './TemplateName';

/**
 * How a template splits an expense (request 25): equally between the members listed, or by whole shares. A split by exact amounts
 * makes no template: its amounts depend on an expense's amount. It is the split an expense takes when it is given the template, as
 * if this split had been given (request 7), so it is one of the two ways a split is asked.
 */
export type TemplateSplit =
  | { readonly kind: 'equal'; readonly memberIds: readonly string[] }
  | { readonly kind: 'shares'; readonly shares: readonly { readonly memberId: string; readonly shares: number }[] };

/** The members a template's split is between, in the order it lists them. */
export const memberIdsOfTemplate = (split: TemplateSplit): string[] =>
  split.kind === 'equal' ? [...split.memberIds] : split.shares.map(line => line.memberId);

/** A template as it is stored: its group, its name, its split, who saved it, and the version it was read at. */
export interface SplitTemplateSnapshot {
  id: string;
  groupId: string;
  name: string;
  split: TemplateSplit;
  savedBy: string;
  version: number;
}

/**
 * A split saved under a name in a group (request 25), an aggregate of Ledger of its own: an expense that is given it takes its split and
 * keeps its shares, never a reference to it, so changing or removing a template changes no expense. It carries the version it was loaded
 * at, and its repository refuses to save it over a newer one (CONC-OPTIMISTIC).
 */
export class SplitTemplate extends AggregateRoot {
  readonly #groupId: string;
  readonly #savedBy: string;
  #name: string;
  #split: TemplateSplit;

  private constructor(id: Id, version: number, groupId: string, name: string, split: TemplateSplit, savedBy: string) {
    super(id, version);
    this.#groupId = groupId;
    this.#name = name;
    this.#split = split;
    this.#savedBy = savedBy;
  }

  /** A new template of a group, its id generated here. Records `TemplateSaved`. */
  static create({
    groupId,
    name,
    split,
    savedBy,
  }: {
    groupId: string;
    name: TemplateName;
    split: TemplateSplit;
    savedBy: string;
  }): SplitTemplate {
    const template = new SplitTemplate(Id.generate(), 0, groupId, name.value, split, savedBy);
    template.record(TemplateSavedEvent.set({ templateId: template._id.value, groupId, name: name.value }));
    return template;
  }

  /** Rebuilds a template as it was stored. Records nothing, and throws on data no `create()` could have made. */
  static fromSnapshot(snapshot: SplitTemplateSnapshot): SplitTemplate {
    const name = TemplateName.create(snapshot.name);
    if (name.isFailure() || !Number.isInteger(snapshot.version) || snapshot.version < 1) {
      throw new Error(`The stored split template ${snapshot.id} is corrupted`);
    }
    return new SplitTemplate(
      new Id(snapshot.id),
      snapshot.version,
      snapshot.groupId,
      name.data!.value,
      snapshot.split,
      snapshot.savedBy,
    );
  }

  /** The template is this name and split from now on, the member who saved it unchanged. Records `TemplateReplaced`. */
  replace({ name, split }: { name: TemplateName; split: TemplateSplit }): void {
    this.#name = name.value;
    this.#split = split;
    this.record(TemplateReplacedEvent.set({ templateId: this._id.value, groupId: this.#groupId, name: name.value }));
  }

  /** The template is removed: no expense is changed by it. Records `TemplateRemoved`. */
  remove(): void {
    this.record(TemplateRemovedEvent.set({ templateId: this._id.value, groupId: this.#groupId }));
  }

  toSnapshot(): SplitTemplateSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      name: this.#name,
      split: this.#split,
      savedBy: this.#savedBy,
      version: this.version,
    };
  }
}
