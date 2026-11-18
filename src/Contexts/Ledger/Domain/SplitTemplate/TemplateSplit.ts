import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * A split a template keeps, as it is given: equally between members, or by shares (request 25). Exact amounts make no template, since
 * they depend on an expense's amount; the expense splits by it as if its split had been given, under the rules of the expense.
 */
export type TemplateSplit = Extract<SplitInput, { kind: 'equal' | 'shares' }>;
