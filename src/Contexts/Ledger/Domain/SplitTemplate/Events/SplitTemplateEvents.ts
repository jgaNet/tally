import { DomainEvent } from '@Architecture/Domain';

/** A member saved a split under a name in a group: the template and its group. */
export class TemplateSavedEvent extends DomainEvent<{ templateId: string; groupId: string }> {}

/** A template was replaced, under the same name or another, by its saver or the group's owner. */
export class TemplateReplacedEvent extends DomainEvent<{ templateId: string; groupId: string }> {}

/** A template was removed: the expenses split by it keep the shares they were given. */
export class TemplateRemovedEvent extends DomainEvent<{ templateId: string; groupId: string }> {}
