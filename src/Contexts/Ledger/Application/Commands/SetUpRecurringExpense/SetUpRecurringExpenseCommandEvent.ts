import { CommandEvent } from '@Architecture/Domain';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** A recurring expense a member pays every month: its group, what it is for, its amount in the group's currency, the day of its first month, and its split (exactly one of the three). */
export class SetUpRecurringExpenseCommandEvent extends CommandEvent<
  {
    groupId: string;
    description: string;
    amount: number;
    startsOn: string;
    /** What each of its expenses is filed under (request 24); `other` when left out. */
    category?: string;
  } & SplitRequest
> {}
