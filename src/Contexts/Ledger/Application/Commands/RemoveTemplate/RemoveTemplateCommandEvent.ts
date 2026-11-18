import { CommandEvent } from '@Architecture/Domain';

/** The payload of a template removed: the template, as the route names it. The remover is the caller. */
export interface RemoveTemplatePayload {
  templateId: string;
}

export class RemoveTemplateCommandEvent extends CommandEvent<RemoveTemplatePayload> {}
