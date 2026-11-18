import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

/**
 * The expense a receipt is decided on (request 26): Ledger's own read model of its expenses, read by the command that decides, inside its
 * transaction, so it takes no lock of its own. Null when there is no such expense, or it has been deleted.
 */
export interface IExpenseFacts {
  expenseOf(id: string): Promise<ExpenseReadModel | null>;
}
