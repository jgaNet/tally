import { DomainEvent } from '@Architecture/Domain';

/** A split was saved under a name in a group, by a member (request 25). */
export class TemplateSavedEvent extends DomainEvent<{
  templateId: string;
  groupId: string;
  name: string;
  savedBy: string;
}> {}

/** A template was replaced: its id, its group and its new name. Its split is what the aggregate holds. */
export class TemplateReplacedEvent extends DomainEvent<{ templateId: string; groupId: string; name: string }> {}

/** A template was removed: its id and its group. An expense split by it keeps its shares (request 25). */
export class TemplateRemovedEvent extends DomainEvent<{ templateId: string; groupId: string }> {}
