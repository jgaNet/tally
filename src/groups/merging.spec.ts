import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabaseUrl,
} from '../test-support';

interface Who {
  id: string;
  token: string;
}

interface Expense {
  id: string;
  groupId: string;
  paidBy: string;
  amount: number;
  version: number;
  splitKind: string;
  shares: { memberId: string; amount: number }[];
}

describe('merging two groups', () => {
  let app: Application;
  let provider: FakeProvider;

  beforeEach(async () => {
    provider = await startFakeProvider();
    app = await createApplication({
      databaseUrl: await temporaryDatabaseUrl(),
      providerUrl: provider.url,
      providerWebhookSecret: 'shared-secret',
      providerTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  async function person(name: string): Promise<Who> {
    return signedUpAccount(app, { email: `${name.toLowerCase()}@example.com`, name });
  }

  async function createdGroup(owner: Who, name: string, currency = 'EUR'): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token: owner.token, payload: { name, currency } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function read<T>(token: string, path: string): Promise<T> {
    const response = await send(app, 'GET', path, { token });
    expect(response.statusCode).toBe(200);
    return response.json<T>();
  }

  async function recordExpense(
    payer: Who,
    groupId: string,
    body: { description: string; amount: number; splitBetween: string[] },
  ): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: payer.token,
      payload: { ...body, date: todayInUtc() },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function merge(keeper: Who, keptId: string, fromId: string) {
    return send(app, 'POST', `/groups/${keptId}/merge`, { token: keeper.token, payload: { from: fromId } });
  }

  const balancesOf = async (who: Who, groupId: string) =>
    new Map(
      (await read<{ memberId: string; balance: number }[]>(who.token, `/groups/${groupId}/balances`)).map(entry => [
        entry.memberId,
        entry.balance,
      ]),
    );

  it('moves what the group merged holds into the group kept, each thing keeping its id and what it says', async () => {
    const ada = await person('Ada');
    const grace = await person('Grace');
    const carl = await person('Carl');
    const dan = await person('Dan');
    const kept = await createdGroup(ada, 'Flat');
    await joinThroughInvitation(app, ada.token, grace.token, kept);
    const mergedId = await createdGroup(ada, 'Rent');
    await joinThroughInvitation(app, ada.token, carl.token, mergedId);
    await joinThroughInvitation(app, ada.token, grace.token, mergedId);
    await joinThroughInvitation(app, ada.token, dan.token, mergedId);

    const keptExpense = await recordExpense(grace, kept, {
      description: 'Bread',
      amount: 600,
      splitBetween: [ada.id, grace.id],
    });
    const mergedExpense = await recordExpense(ada, mergedId, {
      description: 'Rent',
      amount: 1000,
      splitBetween: [ada.id, carl.id, grace.id, dan.id],
    });
    const paid = await send(app, 'POST', `/groups/${mergedId}/settlements/cash`, {
      token: ada.token,
      payload: { from: carl.id, amount: 100 },
    });
    expect(paid.statusCode).toBe(201);
    const settlementId = paid.json<{ id: string }>().id;
    const recurring = await send(app, 'POST', `/groups/${mergedId}/recurring`, {
      token: ada.token,
      payload: { description: 'Internet', amount: 3000, startsOn: '2026-01-05', splitBetween: [ada.id, carl.id] },
    });
    expect(recurring.statusCode).toBe(201);
    const recurringId = recurring.json<{ id: string }>().id;
    const mergedAudit = await read<{ id: string }[]>(ada.token, `/groups/${mergedId}/audit`);

    const keptBefore = await balancesOf(ada, kept);
    const mergedBefore = await balancesOf(ada, mergedId);
    const keptMembersBefore = await read<{ memberId: string; joinedAt: string }[]>(
      ada.token,
      `/groups/${kept}/members`,
    );

    expect((await merge(ada, kept, mergedId)).statusCode).toBe(204);

    // The group merged is gone, for anyone.
    expect((await send(app, 'GET', `/groups/${mergedId}`, { token: grace.token })).statusCode).toBe(404);
    expect((await send(app, 'GET', `/groups/${mergedId}/expenses`, { token: ada.token })).statusCode).toBe(404);
    expect(
      (
        await send(app, 'POST', `/groups/${mergedId}/expenses`, {
          token: ada.token,
          payload: { description: 'Late', amount: 100, date: todayInUtc(), splitBetween: [ada.id] },
        })
      ).statusCode,
    ).toBe(404);

    // Expenses keep their id, payer, shares and version, and are the group kept's from then on.
    const expenses = await read<Expense[]>(ada.token, `/groups/${kept}/expenses`);
    expect(expenses.map(expense => expense.id).sort()).toEqual([keptExpense, mergedExpense].sort());
    const moved = await read<Expense>(ada.token, `/expenses/${mergedExpense}`);
    expect(moved).toMatchObject({ groupId: kept, paidBy: ada.id, amount: 1000, version: 1, splitKind: 'equal' });
    expect(moved.shares).toHaveLength(4);

    const settlement = await read<{ groupId: string; status: string; from: string; to: string }>(
      ada.token,
      `/settlements/${settlementId}`,
    );
    expect(settlement).toMatchObject({ groupId: kept, status: 'paid', from: carl.id, to: ada.id });
    expect((await read<{ id: string }[]>(ada.token, `/groups/${kept}/settlements`)).map(entry => entry.id)).toContain(
      settlementId,
    );

    expect((await read<{ groupId: string }>(ada.token, `/recurring/${recurringId}`)).groupId).toBe(kept);
    expect((await read<{ id: string }[]>(ada.token, `/groups/${kept}/recurring`)).map(entry => entry.id)).toContain(
      recurringId,
    );

    // Its audit entries are the group kept's, at their place.
    const keptAuditIds = (await read<{ id: string }[]>(ada.token, `/groups/${kept}/audit`)).map(entry => entry.id);
    for (const entry of mergedAudit) {
      expect(keptAuditIds).toContain(entry.id);
    }

    // Each member's balance is what it was in each group, added up; every balance adds up to 0.
    const keptAfter = await balancesOf(ada, kept);
    const members = [...new Set([...keptBefore.keys(), ...mergedBefore.keys()])];
    for (const memberId of members) {
      expect(keptAfter.get(memberId)).toBe((keptBefore.get(memberId) ?? 0) + (mergedBefore.get(memberId) ?? 0));
    }
    expect([...keptAfter.values()].reduce((sum, balance) => sum + balance, 0)).toBe(0);

    // The members of the group merged who were not in the group kept join it after its members, as members.
    const afterMerge = await read<{ memberId: string; role: string; joinedAt: string }[]>(
      ada.token,
      `/groups/${kept}/members`,
    );
    expect(afterMerge.map(member => member.memberId)).toEqual([ada.id, grace.id, carl.id, dan.id]);
    expect(afterMerge.map(member => member.role)).toEqual(['owner', 'member', 'member', 'member']);
    const graceBefore = keptMembersBefore.find(member => member.memberId === grace.id);
    expect(afterMerge.find(member => member.memberId === grace.id)?.joinedAt).toBe(graceBefore?.joinedAt);
  });

  it('keeps a former member of the group merged as a former member of the group kept, whose statement is read there', async () => {
    const ada = await person('Ada');
    const carl = await person('Carl');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Trip');
    await joinThroughInvitation(app, ada.token, carl.token, mergedId);
    const trip = await recordExpense(ada, mergedId, {
      description: 'Taxi',
      amount: 800,
      splitBetween: [ada.id, carl.id],
    });
    const left = await send(app, 'POST', `/groups/${mergedId}/leave`, { token: carl.token });
    expect(left.statusCode).toBe(204);
    const statementPath = `/groups/${mergedId}/members/${carl.id}/statement`;
    const statementBefore = await read<{ entries: { expenseId: string }[] }>(ada.token, statementPath);
    expect(statementBefore.entries.map(entry => entry.expenseId)).toEqual([trip]);

    expect((await merge(ada, kept, mergedId)).statusCode).toBe(204);

    const members = await read<{ memberId: string }[]>(ada.token, `/groups/${kept}/members`);
    expect(members.map(member => member.memberId)).toEqual([ada.id]);
    // Their statement is read in the group kept, and says what it said in the group merged.
    expect(await read(ada.token, `/groups/${kept}/members/${carl.id}/statement`)).toEqual(statementBefore);
  });

  it('lets the invitations of the group kept work, and drops those of the group merged, with its budgets', async () => {
    const ada = await person('Ada');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Rent');
    const keptBudget = await send(app, 'PUT', `/groups/${kept}/budgets/food`, {
      token: ada.token,
      payload: { amount: 5000 },
    });
    expect(keptBudget.statusCode).toBe(204);
    const mergedBudget = await send(app, 'PUT', `/groups/${mergedId}/budgets/rent`, {
      token: ada.token,
      payload: { amount: 90000 },
    });
    expect(mergedBudget.statusCode).toBe(204);
    const created = await send(app, 'POST', `/groups/${mergedId}/invitations`, { token: ada.token });
    const invitation = created.json<{ id: string }>().id;

    expect((await merge(ada, kept, mergedId)).statusCode).toBe(204);

    const grace = await person('Grace');
    expect((await send(app, 'GET', `/invitations/${invitation}`, { token: grace.token })).statusCode).toBe(404);
    expect((await send(app, 'POST', `/invitations/${invitation}/accept`, { token: grace.token })).statusCode).toBe(404);
    await joinThroughInvitation(app, ada.token, grace.token, kept);

    const budgets = await read<{ category: string }[]>(ada.token, `/groups/${kept}/budgets`);
    expect(budgets.map(budget => budget.category)).toEqual(['food']);
  });

  it('keeps the notices of the group merged as they were made', async () => {
    const ada = await person('Ada');
    const carl = await person('Carl');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Rent');
    await joinThroughInvitation(app, ada.token, carl.token, mergedId);
    const expense = await recordExpense(ada, mergedId, {
      description: 'Rent',
      amount: 1000,
      splitBetween: [ada.id, carl.id],
    });

    expect((await merge(ada, kept, mergedId)).statusCode).toBe(204);

    const notices = await read<{ kind: string; groupId: string; expenseId: string }[]>(carl.token, '/notices');
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'expense', groupId: mergedId, expenseId: expense }));
  });

  it('refuses a merge of the same group, by someone who does not own both, or of groups in different currencies', async () => {
    const ada = await person('Ada');
    const grace = await person('Grace');
    const carl = await person('Carl');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Rent');

    const same = await merge(ada, kept, kept);
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ type: 'SameGroup' });

    // A member who is not the owner of the group kept is refused, as is one who does not own the group merged.
    const graceOwns = await createdGroup(grace, 'Trip');
    await joinThroughInvitation(app, ada.token, grace.token, kept);
    const notOwnerOfKept = await merge(grace, kept, graceOwns);
    expect(notOwnerOfKept.statusCode).toBe(403);
    expect(notOwnerOfKept.json()).toMatchObject({ type: 'NotPermitted' });
    await joinThroughInvitation(app, grace.token, ada.token, graceOwns);
    const notOwnerOfMerged = await merge(ada, kept, graceOwns);
    expect(notOwnerOfMerged.statusCode).toBe(403);

    // Anyone outside a group does not see it: the same answer as for a group that does not exist.
    const carlOwns = await createdGroup(carl, 'Camp');
    expect((await merge(ada, kept, carlOwns)).statusCode).toBe(404);
    expect((await merge(ada, kept, 'no-such-group')).statusCode).toBe(404);

    // Groups in other currencies are not merged.
    const dollars = await createdGroup(ada, 'Dollars', 'USD');
    const currency = await merge(ada, kept, dollars);
    expect(currency.statusCode).toBe(409);
    expect(currency.json()).toMatchObject({ type: 'CurrencyMismatch' });

    // Nothing has moved: both groups are still there.
    expect((await send(app, 'GET', `/groups/${mergedId}`, { token: ada.token })).statusCode).toBe(200);
    expect((await send(app, 'GET', `/groups/${kept}`, { token: ada.token })).statusCode).toBe(200);
  });

  it('refuses a merge of an archived group, either of the two', async () => {
    const ada = await person('Ada');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Rent');
    expect((await send(app, 'POST', `/groups/${mergedId}/archive`, { token: ada.token })).statusCode).toBe(204);

    const archivedMerged = await merge(ada, kept, mergedId);
    expect(archivedMerged.statusCode).toBe(409);
    expect(archivedMerged.json()).toMatchObject({ type: 'GroupArchived' });

    const other = await createdGroup(ada, 'Flat 2');
    expect((await send(app, 'POST', `/groups/${other}/archive`, { token: ada.token })).statusCode).toBe(204);
    expect((await merge(ada, other, kept)).json()).toMatchObject({ type: 'GroupArchived' });
  });

  it('refuses a merge while a payment through the provider in the group merged is pending', async () => {
    const ada = await person('Ada');
    const grace = await person('Grace');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Rent');
    await joinThroughInvitation(app, ada.token, grace.token, mergedId);
    await recordExpense(ada, mergedId, { description: 'Rent', amount: 1000, splitBetween: [ada.id, grace.id] });
    await setPayoutAccount(app, ada.token, ada.id);
    const asked = await send(app, 'POST', `/groups/${mergedId}/settlements/provider`, {
      token: grace.token,
      payload: { to: ada.id, amount: 500 },
    });
    expect(asked.statusCode).toBe(201);

    const refused = await merge(ada, kept, mergedId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ type: 'PaymentPending' });
    expect((await send(app, 'GET', `/groups/${mergedId}`, { token: ada.token })).statusCode).toBe(200);
  });

  it('counts an expense recorded at the moment of the merge once in the group kept, or refuses it', async () => {
    const ada = await person('Ada');
    const grace = await person('Grace');
    const kept = await createdGroup(ada, 'Flat');
    const mergedId = await createdGroup(ada, 'Rent');
    await joinThroughInvitation(app, ada.token, grace.token, mergedId);

    const [merged, recorded] = await Promise.all([
      merge(ada, kept, mergedId),
      send(app, 'POST', `/groups/${mergedId}/expenses`, {
        token: grace.token,
        payload: { description: 'Milk', amount: 400, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
      }),
    ]);
    expect(merged.statusCode).toBe(204);
    expect([201, 404]).toContain(recorded.statusCode);

    const expenses = await read<{ id: string }[]>(ada.token, `/groups/${kept}/expenses`);
    const counted = expenses.filter(expense => expense.id === recorded.json<{ id?: string }>().id);
    expect(counted).toHaveLength(recorded.statusCode === 201 ? 1 : 0);
    const balances = [...(await balancesOf(ada, kept)).values()];
    expect(balances.reduce((sum, balance) => sum + balance, 0)).toBe(0);
  });
});
