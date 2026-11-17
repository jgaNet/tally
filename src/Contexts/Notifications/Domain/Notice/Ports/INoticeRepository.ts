import { IResult } from '@Architecture/Domain';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * The notices, as aggregates. It saves them, and answers the fact the rule "made once from the fact" needs about the
 * collection: who already holds a notice of an expense. A notice saved twice for the same expense and recipient is
 * refused with a ConcurrencyConflictException.
 */
export interface INoticeRepository {
  /** The members who already hold a notice of the expense. */
  recipientsOf(expenseId: string): Promise<string[]>;
  save(notice: Notice): Promise<IResult>;
}
