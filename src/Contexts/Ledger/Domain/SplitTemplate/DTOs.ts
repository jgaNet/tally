import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/** A split template as it is stored: its group, its name, the split as it was given, who saved it, and its version. */
export interface ISplitTemplateSnapshot {
  _id: string;
  groupId: string;
  name: string;
  split: TemplateSplit;
  savedBy: string;
  version: number;
}
