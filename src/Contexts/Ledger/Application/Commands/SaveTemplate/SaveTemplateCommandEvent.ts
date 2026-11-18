import { CommandEvent } from '@Architecture/Domain';

import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/** The payload of a template saved: the group (as the route names it), the name, and the split as it was given. The saver is the caller. */
export interface SaveTemplatePayload {
  groupId: string;
  name: string;
  split: TemplateSplit;
}

export class SaveTemplateCommandEvent extends CommandEvent<SaveTemplatePayload> {}
