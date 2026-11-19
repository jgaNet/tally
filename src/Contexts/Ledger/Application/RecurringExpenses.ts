import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { memberIdsOfSplit, SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import {
  decideSetUpRecurringExpense,
  decideStopRecurringExpense,
  decideSweepRecurringExpense,
} from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense.decision';

import { IGroupMembers, MemberOfGroup } from './IGroupMembers';
import { anyDeletedOf } from './anyDeletedOf';
import { IRecurringExpenseQueries, RecurringExpenseView } from './IRecurringExpenseQueries';
import { IRecurringExpenseRepository } from './IRecurringExpenseRepository';

/** What a member sets up: the group, the description, the amount in the group's currency, `startsOn`, and the split as given (request 23). */
export interface SetUpRecurringExpenseInput {
  groupId: string;
  description: string;
  amount: number;
  startsOn: string;
  split: SplitRequest;
  /** What its expenses are for (request 24); `other` when none is given. */
  category?: string;
}

/**
 * A member of a group sets up an expense they pay every month (request 23): the caller is its payer, the expense is checked as an
 * expense is (its description, amount and split), and `startsOn` as the decision says. Answers the new recurring expense's id. Anyone who
 * is not a member gets the answer for a group that does not exist.
 */
export const setUpRecurringExpense = command(
  'SetUpRecurringExpense',
  (recurring: IRecurringExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, description, amount, startsOn, split, category }: SetUpRecurringExpenseInput, context) => {
      return recurring.inTransaction(async () => {
        const payer = callerOf(context);
        const members = await groupMembers.membersOf(groupId, payer);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));

        const decision = decideSetUpRecurringExpense(
          {
            memberIds: memberIdsOf(members),
            archived: await groupMembers.archivedOf(groupId),
            suspended: await groupMembers.suspendedOf(payer),
            deleted: await anyDeletedOf(groupMembers, [payer, ...memberIdsOfSplit(split)]),
          },
          { description, amount, startsOn, split, payer, category },
          clock(),
        );
        if (decision.isFailure()) return decision;

        const created = RecurringExpense.setUp({
          groupId,
          paidBy: decision.data.state.payer,
          description: decision.data.state.description,
          amount: decision.data.state.amount,
          startsOn: decision.data.state.startsOn,
          split: decision.data.state.split,
          category: decision.data.state.category,
        });
        await recurring.insert(created);
        await publishDomainEvents(created, context);
        return Result.ok(created._id.value);
      });
    },
);

/**
 * A member who is the recurring expense's payer, or the group's owner, stops it: it no longer exists, and no expense is recorded for
 * it from then on; the expenses it recorded stay. Any other member is refused; anyone who is not a member gets the answer for a
 * recurring expense that does not exist.
 */
export const stopRecurringExpense = command(
  'StopRecurringExpense',
  (recurring: IRecurringExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      return recurring.inTransaction(async () => {
        const by = callerOf(context);
        const stored = await recurring.get(id);
        if (!stored) return Result.fail(new NotFoundException('Ledger', 'No recurring expense is found'));
        const { groupId, paidBy } = stored.toSnapshot();
        const members = await groupMembers.membersOf(groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No recurring expense is found'));

        const decision = decideStopRecurringExpense(
          { paidBy, ownerId: ownerIdOf(members), archived: await groupMembers.archivedOf(groupId) },
          { by },
          clock(),
        );
        if (decision.isFailure()) return decision;

        stored.stop();
        await recurring.remove(stored);
        await publishDomainEvents(stored, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * A member of the recurring expense's group reads it, as set up and as it is kept: its `next` is the day of the next expense the background
 * job will record. Anyone who is not a member, or nobody, gets the answer for a recurring expense that does not exist.
 */
export const getRecurringExpense = query(
  'GetRecurringExpense',
  (views: IRecurringExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const view: RecurringExpenseView | undefined = await views.recurringOf(id);
      if (!view) return Result.fail(new NotFoundException('Ledger', 'No recurring expense is found'));
      if (!(await groupMembers.membersOf(view.groupId, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No recurring expense is found'));
      }
      return Result.ok(view);
    },
);

/**
 * A member of a group reads its recurring expenses, the earliest set up first, each as `GetRecurringExpense` reads it. Anyone who is not a
 * member gets the answer for a group that does not exist.
 */
export const getGroupRecurringExpenses = query(
  'GetGroupRecurringExpenses',
  (views: IRecurringExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      if (!(await groupMembers.membersOf(id, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      }
      return Result.ok(await views.recurringsOf(id));
    },
);

/**
 * One run of the background job over every recurring expense (request 23, ADR 20): a recurring expense whose payer or a member of its split
 * is no longer a member of the group ends, and records no expense; otherwise each day it falls on up to today that is not yet recorded
 * moves its next day on and records `RecurringExpenseDayCame`, all in one save, its version checked. The facts go out after the commit,
 * and the policy records each day's expense. Nobody calls it but the job: it has no route, so it asks for no caller.
 */
export const sweepRecurringExpenses = command(
  'SweepRecurringExpenses',
  (recurring: IRecurringExpenseRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async (_input: void, context) => {
      return recurring.inTransaction(async () => {
        const now = clock();
        for (const stored of await recurring.all()) {
          const snapshot = stored.toSnapshot();
          const members = await groupMembers.membersOf(snapshot.groupId, snapshot.paidBy);
          const decision = decideSweepRecurringExpense(
            {
              recurring: snapshot,
              memberIds: members && memberIdsOf(members),
              archived: await groupMembers.archivedOf(snapshot.groupId),
              suspended: await groupMembers.suspendedOf(snapshot.paidBy),
              deleted: await anyDeletedOf(groupMembers, [snapshot.paidBy, ...memberIdsOfSplit(snapshot.split)]),
            },
            undefined,
            now,
          );
          if (decision.isFailure()) return decision;

          const outcome = decision.data.state;
          if (outcome.kind === 'ended') {
            stored.end();
            await recurring.remove(stored);
          } else {
            if (outcome.days.length === 0) continue;
            for (const day of outcome.days) stored.recordDay(day);
            await recurring.save(stored);
          }
          await publishDomainEvents(stored, context);
        }
        return Result.ok(undefined);
      });
    },
  { caller: 'anyone' },
);

const memberIdsOf = (members: MemberOfGroup[]): string[] => members.map(member => member.memberId);

/** The group's owner, the member whose role is owner; no one, if none is (a group always has one). */
const ownerIdOf = (members: MemberOfGroup[]): string => members.find(member => member.role === 'owner')?.memberId ?? '';
