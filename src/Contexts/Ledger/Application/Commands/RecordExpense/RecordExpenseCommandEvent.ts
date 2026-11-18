import { CommandEvent } from '@Architecture/Domain';
import { OriginalRequest, SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';

/**
 * The expense a member paid: its group, what it was for, its amount, its date, and how it is split: between members, by
 * exact amounts, or by shares (exactly one of the three).
 */
export class RecordExpenseCommandEvent extends CommandEvent<
  {
    groupId: string;
    description: string;
    /** The amount in the group's currency, or `original` what was paid in another one (exactly one of the two, request 21); its rate may be left out (request 22). */
    amount?: number;
    original?: OriginalRequest;
    date: string;
    /** What the expense is filed under (request 24); `other` when left out. */
    category?: string;
  } & SplitRequest & {
      /** The id of a template of the group, split as it was saved, in place of one of the three splits (request 25). */
      template?: string;
    }
> {}
