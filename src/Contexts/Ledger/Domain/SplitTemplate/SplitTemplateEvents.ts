import { DomainEvent } from '@Architecture/Domain';

/** A member saved a split under a name in a group (request 25). Recorded by `SplitTemplate.create`. */
export class TemplateSavedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  name: string;
}> {}

/** The member who saved a template, or the group's owner, replaced it (request 25). Recorded by `SplitTemplate.replace`. */
export class TemplateReplacedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  name: string;
}> {}

/** The member who saved a template, or the group's owner, removed it (request 25). Recorded by `SplitTemplate.remove`. */
export class TemplateRemovedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
}> {}
