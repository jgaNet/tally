import { CommandEvent } from '@Architecture/Domain';

/** The member who saved a template, or the owner of its group, removes it (request 25). The expenses split by it keep their shares. */
export class RemoveTemplateCommandEvent extends CommandEvent<{ templateId: string }> {}
