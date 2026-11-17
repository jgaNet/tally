import { CommandEvent } from '@Architecture/Domain';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';

/**
 * The expense a member gives again, whole: what it is for, what it cost, its date, how it is split (exactly one of the
 * three, as recording gives it), and the version the member read it at. Its payer is not given: it stays the one who paid.
 */
export class EditExpenseCommandEvent extends CommandEvent<
  {
    expenseId: string;
    description: string;
    amount: number;
    date: string;
    version: number;
  } & SplitRequest
> {}
