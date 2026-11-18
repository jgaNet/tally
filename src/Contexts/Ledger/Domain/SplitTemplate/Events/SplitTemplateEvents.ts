import { DomainEvent } from '@Architecture/Domain';

/** A split was saved under a name by a member of a group (request 25). Recorded by `SplitTemplate.create()`, once it is stored. */
export class TemplateSavedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  name: string;
  createdBy: string;
}> {}

/** A template was replaced, by the member who saved it or the group's owner (request 25). Recorded by `SplitTemplate.replace()`. */
export class TemplateReplacedEvent extends DomainEvent<{ templateId: string; groupId: string; name: string }> {}

/** A template was removed, by the member who saved it or the group's owner (request 25). Recorded by `SplitTemplate.delete()`. */
export class TemplateRemovedEvent extends DomainEvent<{ templateId: string; groupId: string }> {}
