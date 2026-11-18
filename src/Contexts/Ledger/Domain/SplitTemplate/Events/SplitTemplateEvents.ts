import { DomainEvent } from '@Architecture/Domain';

/** A member saved a split under a name in a group (request 25). */
export class TemplateSavedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  savedBy: string;
  savedAt: string;
}> {}

/** The member who saved a template, or the owner of its group, replaced it: its name and its split, as given. */
export class TemplateReplacedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  replacedBy: string;
  replacedAt: string;
}> {}

/** The member who saved a template, or the owner of its group, removed it. Expenses split by it keep their shares. */
export class TemplateRemovedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  removedBy: string;
  removedAt: string;
}> {}
