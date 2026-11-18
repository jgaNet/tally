import { CommandEvent } from '@Architecture/Domain';
import { TemplateSplitRequest } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/** A member of a group saves a split under a name: exactly one of its two splits, equally between members or by shares (request 25). */
export class SaveTemplateCommandEvent extends CommandEvent<
  {
    groupId: string;
    name: string;
  } & TemplateSplitRequest
> {}
