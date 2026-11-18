import { CommandEvent } from '@Architecture/Domain';

import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/**
 * A member of a group saves a split under a name (request 25): equally between members, or by shares. The name and the split are checked
 * by the template, behind the 202.
 */
export class SaveTemplateCommandEvent extends CommandEvent<{ groupId: string; name: string; split: TemplateSplit }> {}
