import { CommandEvent } from '@Architecture/Domain';

import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/**
 * The member who saved a template, or the owner of its group, replaces it whole, under the rules of saving it (request 25). The name and
 * the split are checked by the template, behind the 202.
 */
export class ReplaceTemplateCommandEvent extends CommandEvent<{
  templateId: string;
  name: string;
  split: TemplateSplit;
}> {}
