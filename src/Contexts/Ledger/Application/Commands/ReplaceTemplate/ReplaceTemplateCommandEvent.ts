import { CommandEvent } from '@Architecture/Domain';

import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/** The payload of a template replaced: the template (as the route names it), and the name and split it is given instead. The replacer is the caller. */
export interface ReplaceTemplatePayload {
  templateId: string;
  name: string;
  split: TemplateSplit;
}

export class ReplaceTemplateCommandEvent extends CommandEvent<ReplaceTemplatePayload> {}
