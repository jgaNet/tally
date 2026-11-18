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
    /** The amount in the group's currency, or `original` what was paid in another one (exactly one of the two, request 21). */
    amount?: number;
    original?: OriginalRequest;
    date: string;
  } & SplitRequest
> {}
