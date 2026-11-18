import { CommandEvent } from '@Architecture/Domain';
import { TemplateSplitRequest } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/** The template given again, whole: its name and its split, as saving gives them (request 25). */
export class ReplaceTemplateCommandEvent extends CommandEvent<
  {
    templateId: string;
    name: string;
  } & TemplateSplitRequest
> {}
