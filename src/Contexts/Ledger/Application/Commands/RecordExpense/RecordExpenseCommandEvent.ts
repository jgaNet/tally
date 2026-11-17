import { CommandEvent } from '@Architecture/Domain';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';

/**
 * The expense a member paid: its group, what it was for, its amount, its date, and how it is split: between members, by
 * exact amounts, or by shares (exactly one of the three).
 */
export class RecordExpenseCommandEvent extends CommandEvent<
  {
    groupId: string;
    description: string;
    amount: number;
    date: string;
  } & SplitRequest
> {}
