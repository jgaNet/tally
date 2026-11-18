import { CommandEvent } from '@Architecture/Domain';

/** The member who saved a template, or the owner of its group, removes it (request 25). */
export class RemoveTemplateCommandEvent extends CommandEvent<{ templateId: string }> {}
