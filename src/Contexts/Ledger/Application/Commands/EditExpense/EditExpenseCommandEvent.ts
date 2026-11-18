import { CommandEvent } from '@Architecture/Domain';
import { OriginalRequest, SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';

/**
 * The expense a member gives again, whole: what it is for, what it cost, its date, how it is split (exactly one of the
 * three, as recording gives it), and the version the member read it at. Its payer is not given: it stays the one who paid.
 */
export class EditExpenseCommandEvent extends CommandEvent<
  {
    expenseId: string;
    description: string;
    /** The amount in the group's currency, or `original` what was paid in another one (exactly one of the two, request 21); its rate may be left out (request 22). */
    amount?: number;
    original?: OriginalRequest;
    date: string;
    /** What the expense is filed under (request 24); `other` when left out. */
    category?: string;
    version: number;
  } & SplitRequest & {
      /** The id of a template of the group, split as it was saved, in place of one of the three splits (request 25). */
      template?: string;
    }
> {}
