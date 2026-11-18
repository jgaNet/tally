import { CATEGORIES } from '@Contexts/Ledger/Domain/Expense/Category';
import { GroupSpending } from '@Contexts/Ledger/Application/Ports/ISpendingQueries';
import { InsightReadModel } from '@Contexts/Ledger/Application/ReadModel/InsightReadModel';

/**
 * The lines of a person's insights (request 37): their shares summed by month, currency and category, across the groups given their
 * currency, a line only where the shares add up to more than 0. The earliest month first; in a month the currencies alphabetically;
 * in a currency the categories in the order request 24 lists them. A group with no currency given is left out.
 */
export function insightsOf(spending: GroupSpending[], currencyOf: ReadonlyMap<string, string>): InsightReadModel[] {
  const lines = new Map<string, InsightReadModel>();
  for (const share of spending) {
    const currency = currencyOf.get(share.groupId);
    if (currency === undefined) continue;
    const key = `${share.month}|${currency}|${share.category}`;
    const line = lines.get(key) ?? { month: share.month, currency, category: share.category, amount: 0 };
    line.amount += share.amount;
    lines.set(key, line);
  }
  return [...lines.values()]
    .filter(line => line.amount > 0)
    .sort(
      (a, b) =>
        compareText(a.month, b.month) ||
        compareText(a.currency, b.currency) ||
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
    );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
