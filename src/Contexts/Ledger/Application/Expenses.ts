import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { AmountInput, OfferedRate, OriginalAmountInput } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { dayOf, Expense, isRealDay } from '@Contexts/Ledger/Domain/Expense/Expense';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { RateView, StatementView } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { CURRENCIES, CurrencyCode } from '@SharedKernel/Domain/Currency';
import { ISplitTemplates } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplates';
import { splitGiven } from '@Contexts/Ledger/Application/SplitTemplates';

/** What a member asks to record: the group, and the expense as the member gives it, with how it is split. */
export interface RecordExpenseInput {
  groupId: string;
  description: string;
  /** The amount in the group's currency, or what was paid in another currency (request 21): exactly one of the two. */
  amount?: number;
  /** What was paid in another currency, at the rate the payer states or, left out, the rate offered on the date (request 22). */
  original?: OriginalAmountInput;
  date: string;
  /** How it is split, as given (request 4, request 7): exactly one of this and `template`. */
  split?: SplitInput;
  /** The template whose split it takes, in place of `split` (request 25): one of the group's templates. */
  template?: string;
  /** What the expense is for (request 24): one of the categories, `other` when none is given. */
  category?: string;
}

/**
 * What the caller gives as the amount: its amount in the group's currency, or what it paid in another currency, which is kept with
 * the group's currency the expense converts to (request 21, docs/adr/0020). The group's currency is asked only for the second, and the
 * rate offered for it on the expense's date too (request 22, docs/adr/0021): the Expense decides with the offer as with any input. The
 * offer is asked only for a currency that is one of Tally's, other than the group's, on a real day; any other is refused by the
 * Expense before the offer is read, so nothing is offered for it.
 */
async function amountGiven(
  groupCurrency: IGroupCurrency,
  offeredRates: IOfferedRates,
  callerId: string,
  groupId: string,
  date: string,
  given: { amount?: number; original?: OriginalAmountInput },
): Promise<AmountInput | undefined> {
  if (given.original === undefined) return { amount: given.amount };
  const currency = await groupCurrency.currencyOf(callerId, groupId);
  if (currency === undefined) return undefined;
  const from = given.original.currency;
  const offered: OfferedRate =
    CURRENCIES.includes(from as CurrencyCode) && from !== currency && isRealDay(date)
      ? await offeredRates.offeredRate({ from, to: currency, date })
      : { kind: 'none' };
  return { original: given.original, groupCurrency: currency, offered };
}

/**
 * Records an expense the caller paid, split equally, by exact amounts or by shares between the members given (request 4 and
 * request 7). The caller is its payer and must be a member of the group: for anyone else the group does not exist. Its id is
 * the answer.
 */
export const recordExpense = command(
  'RecordExpense',
  (
    expenses: IExpenseRepository,
    groupMembers: IGroupMembers,
    groupCurrency: IGroupCurrency,
    offeredRates: IOfferedRates,
    clock: Clock,
    templates: ISplitTemplates,
  ) =>
    async (
      { groupId, description, amount, original, date, split, template, category }: RecordExpenseInput,
      context,
    ) => {
      const paidBy = callerOf(context);
      const members = await groupMembers.membersOf(paidBy, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const archived = await groupMembers.isArchived(groupId);
      const money = await amountGiven(groupCurrency, offeredRates, paidBy, groupId, date, { amount, original });
      if (!money) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const chosen = await splitGiven(templates, groupId, { split, template });
      if (chosen.isFailure()) return chosen;

      const expense = Expense.register({
        groupId,
        description,
        ...money,
        date,
        paidBy,
        split: chosen.data,
        category,
        members: members.map(member => member.memberId),
        archived,
        at: clock(),
      });
      if (expense.isFailure()) return expense;

      const saved = await expenses.save(expense.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(expense.data, context);
      return Result.ok(expense.data.id);
    },
);

/** Reads an expense, for the members of its group only: for anyone else it does not exist. */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const expense = await expenses.findExpense(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(callerOf(context), expense.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      return Result.ok(expense);
    },
);

/** What a member asks to change: the expense, and the whole of it as the member gives it, from the version they read. */
export interface EditExpenseInput {
  id: string;
  description: string;
  /** The amount in the group's currency, or what was paid in another currency (request 21): exactly one of the two. */
  amount?: number;
  original?: OriginalAmountInput;
  date: string;
  /** How it is split, as given (request 4, request 7): exactly one of this and `template`. */
  split?: SplitInput;
  /** The template whose split it takes, in place of `split` (request 25): one of the group's templates. */
  template?: string;
  /** What the expense is for (request 24): left out, it is `other`, as the expense is given whole. */
  category?: string;
  version: number;
}

/**
 * Gives an expense again, whole, from the version its author read (request 6, docs/adr/0006). The caller must be a member
 * of its group, for anyone else the expense does not exist; the payer or the group's owner may change it. The payer stays
 * the one who paid. A version the expense has moved past is refused by name, after the store's conflict is re-read.
 */
export const editExpense = command(
  'EditExpense',
  (
    expenses: IExpenseRepository,
    groupMembers: IGroupMembers,
    groupCurrency: IGroupCurrency,
    offeredRates: IOfferedRates,
    clock: Clock,
    templates: ISplitTemplates,
  ) =>
    async (
      { id, description, amount, original, date, split, template, version, category }: EditExpenseInput,
      context,
    ) => {
      const by = callerOf(context);
      const stored = await expenses.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const archived = await groupMembers.isArchived(stored.groupId);

      const money = await amountGiven(groupCurrency, offeredRates, by, stored.groupId, date, { amount, original });
      if (!money) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const chosen = await splitGiven(templates, stored.groupId, { split, template });
      if (chosen.isFailure()) return chosen;
      const edited = stored.edit({
        by,
        members,
        archived,
        version,
        description,
        date,
        split: chosen.data,
        category,
        at: clock(),
        ...money,
      });
      if (edited.isFailure()) return edited;
      const saved = await expenses.save(edited.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(edited.data, context);
      return Result.ok(undefined);
    },
);

/**
 * Deletes an expense, for its payer or the group's owner (request 6, docs/adr/0006). It is gone from every read and counts in
 * no balance from the commit on. For anyone outside its group the expense does not exist.
 */
export const deleteExpense = command(
  'DeleteExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      const stored = await expenses.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const archived = await groupMembers.isArchived(stored.groupId);

      const removed = stored.remove({ by, members, archived, at: clock() });
      if (removed.isFailure()) return removed;
      const saved = await expenses.remove(removed.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(removed.data, context);
      return Result.ok(undefined);
    },
);

/** What a member asks for: the rate offered for a currency to the group's, on a day (`date`, today when left out). */
export interface GetOfferedRateInput {
  groupId: string;
  currency: string;
  date?: string;
}

/**
 * The rate offered for a currency to the group's currency on a day (request 22, docs/adr/0021), for a member of the group only: for
 * anyone else the group does not exist. It is `404` when no rate is offered, when the currency is the group's or not one of Tally's, and
 * when the day is not a real one: a rate is never invented here.
 */
export const getOfferedRate = query(
  'GetOfferedRate',
  (groupCurrency: IGroupCurrency, offeredRates: IOfferedRates, clock: Clock) =>
    async ({ groupId, currency, date }: GetOfferedRateInput, context) => {
      const to = await groupCurrency.currencyOf(callerOf(context), groupId);
      if (to === undefined) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const day = date ?? dayOf(clock());
      if (!CURRENCIES.includes(currency as CurrencyCode) || currency === to || !isRealDay(day)) {
        return Result.fail(new NotFoundException('Ledger', 'There is no such rate'));
      }
      const offer = await offeredRates.offeredRate({ from: currency, to, date: day });
      if (offer.kind !== 'offered') return Result.fail(new NotFoundException('Ledger', 'There is no such rate'));
      const view: RateView = { currency, date: day, rate: offer.rate };
      return Result.ok(view);
    },
);

/**
 * A group's balances, for its members only: each member, in the order they joined, with what they are owed (positive) or
 * owe (negative), 0 when nothing is recorded for them. For anyone else the group does not exist.
 *
 * The balances are read before the members, and membership only grows (leaving is a later feature, docs/adr/0005): so
 * the members read after include every member the balances count, and the balances listed add up to 0 exactly.
 */
export const getGroupBalances = query(
  'GetGroupBalances',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const balances = await expenses.balancesOf(groupId);
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const owed = new Map(balances.map(({ memberId, balance }) => [memberId, balance]));
      return Result.ok(members.map(({ memberId }) => ({ memberId, balance: owed.get(memberId) ?? 0 })));
    },
);

/**
 * A group's expenses, for its members only: each as `GetExpense` reads it, the latest date first and, on the same date, the most
 * recently recorded first (request 8, docs/adr/0008). For anyone else the group does not exist.
 */
export const getGroupExpenses = query(
  'GetGroupExpenses',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      return Result.ok(await expenses.expensesOf(groupId));
    },
);

/**
 * A member's statement in a group, for its members only (request 8, docs/adr/0008): every expense the member paid or is in the
 * split of, the earliest date first and, on the same date, the earliest recorded first, each with the balance once it is counted.
 * Its balance is the last entry's, or 0 with no entry: the balance the group's balances give the member (request 5). For anyone
 * else the group does not exist, and a member who has never been one of the group does not exist either. A former member's
 * statement stays readable by the group's members (request 9, docs/adr/0009).
 *
 * The caller's membership is read before the statement, and the statement is read after it: a member who has been one of the
 * group is one still or has left with a balance of 0, so the statement's entries are the same whichever way the read falls.
 */
export const getMemberStatement = query(
  'GetMemberStatement',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ groupId, memberId }: { groupId: string; memberId: string }, context) => {
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      if (!(await groupMembers.hasBeenMember(groupId, memberId))) {
        return Result.fail(new NotFoundException('Ledger', 'There is no such member'));
      }
      const entries = await expenses.statementOf(groupId, memberId);
      const statement: StatementView = { memberId, balance: entries.at(-1)?.balance ?? 0, entries };
      return Result.ok(statement);
    },
);
