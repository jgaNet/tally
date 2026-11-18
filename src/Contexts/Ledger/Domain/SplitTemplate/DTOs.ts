import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/**
 * What a template is, as it is kept: its group, its name, the member who saved it, and its split as it was given (equally between
 * members, or by shares). Its id is the one it was born with; its version is the one it was last saved at (1 when saved).
 */
export interface SplitTemplateSnapshot {
  id: string;
  groupId: string;
  name: string;
  createdBy: string;
  split: TemplateSplit;
  version: number;
}
