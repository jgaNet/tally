import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { todayInUtc } from './validation';

describe('editing and deleting an expense', () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** An expense body as recorded; overrides replace its fields. */
  const expense = (overrides: Record<string, unknown> = {}) => ({
    description: 'Groceries',
    amount: 1000,
    date: todayInUtc(),
    splitBetween: [] as string[],
    ...overrides,
  });

  /** An edit body: an expense as an edit gives it, made from `version`. */
  const edit = (version: number, overrides: Record<string, unknown> = {}) => ({
    description: 'Groceries',
    amount: 1000,
    date: todayInUtc(),
    splitBetween: [] as string[],
    version,
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function putEdit(token: string, expenseId: string, payload: Record<string, unknown>, server = app) {
    return send(server, 'PUT', `/expenses/${expenseId}`, { token, payload });
  }

  async function readExpense(token: string, expenseId: string, server = app) {
    return send(server, 'GET', `/expenses/${expenseId}`, { token });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  /** Ada owns a group with Grace and Linus in it, in that order; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  describe('the version', () => {
    it('is 1 when the expense is recorded', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      expect((await readExpense(ada.token, id)).json().version).toBe(1);
    });

    it('goes up by one at each edit', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      expect((await putEdit(ada.token, id, edit(1, { splitBetween: [ada.id] }))).statusCode).toBe(204);
      expect((await readExpense(ada.token, id)).json().version).toBe(2);
      expect((await putEdit(ada.token, id, edit(2, { splitBetween: [ada.id] }))).statusCode).toBe(204);
      expect((await readExpense(ada.token, id)).json().version).toBe(3);
    });

    it('is not changed by a read', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      await readExpense(ada.token, id);
      await readExpense(ada.token, id);
      expect((await readExpense(ada.token, id)).json().version).toBe(1);
    });

    it('is refused as a version of 0, a fraction, a string, or no version at all, with 400', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      const withoutVersion: Record<string, unknown> = edit(1, { splitBetween: [ada.id] });
      delete withoutVersion.version;
      for (const payload of [
        edit(0, { splitBetween: [ada.id] }),
        edit(1.5, { splitBetween: [ada.id] }),
        edit('1' as unknown as number, { splitBetween: [ada.id] }),
        withoutVersion,
      ]) {
        const response = await putEdit(ada.token, id, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().type).toBe('InvalidBody');
      }
      expect((await readExpense(ada.token, id)).json().version).toBe(1);
    });
  });

  describe('who may edit', () => {
    it('lets the payer edit their own expense', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(grace.token, groupId, expense({ splitBetween: [grace.id, ada.id] }));
      const response = await putEdit(grace.token, id, edit(1, { splitBetween: [grace.id, ada.id] }));
      expect(response.statusCode).toBe(204);
    });

    it('lets the owner of the group edit an expense another member paid, and keeps that member as the payer', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [grace.id, ada.id] }));
      const response = await putEdit(ada.token, id, edit(1, { amount: 600, splitBetween: [ada.id, grace.id] }));
      expect(response.statusCode).toBe(204);
      const after = (await readExpense(ada.token, id)).json();
      expect(after.paidBy).toBe(grace.id);
      expect(after.amount).toBe(600);
    });

    it('refuses another member, who is neither the payer nor the owner, with 403, and changes nothing', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await record(grace.token, groupId, expense({ splitBetween: [grace.id, ada.id] }));
      const before = (await readExpense(linus.token, id)).json();
      const response = await putEdit(linus.token, id, edit(1, { description: 'Mine now', splitBetween: [linus.id] }));
      expect(response.statusCode).toBe(403);
      expect(response.json().type).toBe('NotPermitted');
      expect((await readExpense(linus.token, id)).json()).toEqual(before);
    });

    it('answers 404 to a person outside the group, the same as an expense that does not exist', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const refused = await putEdit(eve.token, id, edit(1, { splitBetween: [eve.id] }));
      const missing = await putEdit(eve.token, 'no-such-expense', edit(1, { splitBetween: [eve.id] }));
      expect(refused.statusCode).toBe(404);
      expect(refused.json().type).toBe('NotFound');
      expect(refused.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      const payload = edit(1, { splitBetween: [ada.id] });
      expect((await send(app, 'PUT', `/expenses/${id}`, { payload })).statusCode).toBe(401);
      expect((await putEdit('not-a-real-token', id, payload)).statusCode).toBe(401);
    });
  });

  describe('the edit itself', () => {
    it('gives the expense again, whole: description, amount, date and split, with the shares computed again', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await record(
        ada.token,
        groupId,
        expense({ amount: 1000, splitBetween: [ada.id, grace.id, linus.id] }),
      );
      const date = '2026-01-05';
      const response = await putEdit(
        ada.token,
        id,
        edit(1, { description: '  Dinner  ', amount: 900, date, splitBetween: [grace.id, ada.id] }),
      );
      expect(response.statusCode).toBe(204);
      expect((await readExpense(linus.token, id)).json()).toEqual({
        id,
        groupId,
        description: 'Dinner',
        amount: 900,
        date,
        paidBy: ada.id,
        version: 2,
        splitKind: 'equal',
        category: 'other',
        shares: [
          { memberId: grace.id, amount: 450 },
          { memberId: ada.id, amount: 450 },
        ],
      });
    });

    it('keeps the payer as the one who paid, and one of the members of the split', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      const refused = await putEdit(ada.token, id, edit(1, { splitBetween: [grace.id] }));
      expect(refused.statusCode).toBe(422);
      expect(refused.json().type).toBe('PayerNotInSplit');
      expect((await readExpense(ada.token, id)).json().version).toBe(1);
    });

    it.each<[string, (ids: { ada: string; grace: string }) => Record<string, unknown>, string]>([
      ['an empty description', () => ({ description: '   ' }), 'InvalidDescription'],
      ['an amount of 0', () => ({ amount: 0 }), 'InvalidAmount'],
      ['a date after today', () => ({ date: '2999-01-01' }), 'InvalidDate'],
      ['a date that is not a day of the calendar', () => ({ date: '2026-02-30' }), 'InvalidDate'],
      ['an empty split', () => ({ splitBetween: [] }), 'InvalidSplit'],
      ['a member listed twice', ({ ada, grace }) => ({ splitBetween: [ada, grace, grace] }), 'InvalidSplit'],
      ['an account outside the group', ({ ada }) => ({ splitBetween: [ada, 'outsider'] }), 'NotAMember'],
    ])('applies the same rules as recording, and refuses %s with 422', async (_label, change, type) => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      const payload = edit(1, { splitBetween: [ada.id, grace.id], ...change({ ada: ada.id, grace: grace.id }) });
      const response = await putEdit(ada.token, id, payload);
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe(type);
      expect((await readExpense(ada.token, id)).json().version).toBe(1);
    });
  });

  describe('a version that has changed since it was read', () => {
    it('refuses an edit made from an older version with 409, and keeps nothing of it', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      expect(
        (await putEdit(ada.token, id, edit(1, { amount: 500, splitBetween: [ada.id, grace.id] }))).statusCode,
      ).toBe(204);
      const before = (await readExpense(ada.token, id)).json();

      const stale = await putEdit(ada.token, id, edit(1, { amount: 77, splitBetween: [ada.id, grace.id] }));
      expect(stale.statusCode).toBe(409);
      expect(stale.json().type).toBe('StaleVersion');
      expect((await readExpense(ada.token, id)).json()).toEqual(before);
    });

    it('refuses an edit from a version that never existed, with 409', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      const response = await putEdit(ada.token, id, edit(7, { splitBetween: [ada.id] }));
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('StaleVersion');
    });
  });

  describe('two edits at once', () => {
    it('keeps exactly one of two edits made from the same version on the same server', async () => {
      const { ada, grace, groupId } = await threeMembers();
      // Grace pays; Grace (the payer) and Ada (the owner) edit it from the same version.
      const id = await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [grace.id, ada.id] }));
      const responses = await Promise.all([
        putEdit(grace.token, id, edit(1, { amount: 400, splitBetween: [grace.id, ada.id] })),
        putEdit(ada.token, id, edit(1, { amount: 800, splitBetween: [ada.id, grace.id] })),
      ]);
      expect(responses.map(response => response.statusCode).sort()).toEqual([204, 409]);
      const kept = (await readExpense(ada.token, id)).json();
      expect(kept.version).toBe(2);
      expect(kept.paidBy).toBe(grace.id);
      expect([400, 800]).toContain(kept.amount);
      expect((await balancesOf(ada.token, groupId)).reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
    });

    it('keeps exactly one of several edits made from the same version through two servers on one file', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ amount: 300, splitBetween: [ada.id, grace.id, linus.id] }));

      const other = await createApplication({ databaseUrl });
      try {
        const attempts = [
          { token: ada.token, amount: 300, split: [ada.id, grace.id] },
          { token: ada.token, amount: 600, split: [ada.id, linus.id] },
          { token: ada.token, amount: 900, split: [ada.id, grace.id, linus.id] },
          { token: ada.token, amount: 1200, split: [ada.id] },
          { token: ada.token, amount: 1500, split: [ada.id, grace.id, linus.id] },
        ];
        const servers = [app, other];
        const responses = await Promise.all(
          attempts.map((attempt, index) =>
            putEdit(
              attempt.token,
              id,
              edit(1, { amount: attempt.amount, splitBetween: attempt.split }),
              servers[index % 2],
            ),
          ),
        );
        const statuses = responses.map(response => response.statusCode);
        expect(statuses.filter(status => status === 204)).toHaveLength(1);
        expect(statuses.filter(status => status === 409)).toHaveLength(attempts.length - 1);

        // Nothing of a refused edit is kept: the expense is exactly the one kept edit, read from either server.
        const kept = (await readExpense(ada.token, id, other)).json();
        expect(kept.version).toBe(2);
        expect(kept.paidBy).toBe(ada.id);
        expect(attempts.some(attempt => attempt.amount === kept.amount)).toBe(true);
        expect(kept.shares.reduce((sum: number, share: { amount: number }) => sum + share.amount, 0)).toBe(kept.amount);

        // Ada paid the one kept expense; each member's balance is what they paid minus their share of it.
        const balances = (await send(other, 'GET', `/groups/${groupId}/balances`, { token: ada.token })).json<
          { memberId: string; balance: number }[]
        >();
        const shareOf = (memberId: string) =>
          kept.shares.find((share: { memberId: string }) => share.memberId === memberId)?.amount ?? 0;
        expect(balances).toEqual([
          { memberId: ada.id, balance: kept.amount - shareOf(ada.id) },
          { memberId: grace.id, balance: 0 - shareOf(grace.id) },
          { memberId: linus.id, balance: 0 - shareOf(linus.id) },
        ]);
        expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
      } finally {
        await other.stop();
      }
    });
  });

  describe('deleting an expense', () => {
    it('lets the payer delete it: it is not read any more, and it counts in no balance', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      expect((await balancesOf(ada.token, groupId)).find(b => b.memberId === ada.id)?.balance).toBe(500);

      const response = await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token });
      expect(response.statusCode).toBe(204);
      const read = await readExpense(ada.token, id);
      expect(read.statusCode).toBe(404);
      expect(read.json().type).toBe('NotFound');
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 0 },
        { memberId: grace.id, balance: 0 },
        { memberId: linus.id, balance: 0 },
      ]);
    });

    it('lets the owner of the group delete an expense another member paid', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(grace.token, groupId, expense({ splitBetween: [grace.id, ada.id] }));
      expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token })).statusCode).toBe(204);
      expect((await readExpense(grace.token, id)).statusCode).toBe(404);
    });

    it('refuses another member, who is neither the payer nor the owner, with 403, and deletes nothing', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await record(grace.token, groupId, expense({ splitBetween: [grace.id, ada.id] }));
      const response = await send(app, 'DELETE', `/expenses/${id}`, { token: linus.token });
      expect(response.statusCode).toBe(403);
      expect(response.json().type).toBe('NotPermitted');
      expect((await readExpense(grace.token, id)).statusCode).toBe(200);
    });

    it('answers 404 to a person outside the group, the same as an expense that does not exist', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const refused = await send(app, 'DELETE', `/expenses/${id}`, { token: eve.token });
      const missing = await send(app, 'DELETE', '/expenses/no-such-expense', { token: eve.token });
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      expect((await send(app, 'DELETE', `/expenses/${id}`)).statusCode).toBe(401);
      expect((await send(app, 'DELETE', `/expenses/${id}`, { token: 'not-a-real-token' })).statusCode).toBe(401);
    });

    it('answers 404 to a second delete, and to an edit of an expense already deleted', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token })).statusCode).toBe(204);
      expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token })).statusCode).toBe(404);
      const edited = await putEdit(ada.token, id, edit(1, { splitBetween: [ada.id] }));
      expect(edited.statusCode).toBe(404);
      expect(edited.json().type).toBe('NotFound');
    });
  });

  describe('what is kept', () => {
    it('keeps an edit, with its version, when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      expect(
        (await putEdit(ada.token, id, edit(1, { amount: 700, splitBetween: [grace.id, ada.id] }))).statusCode,
      ).toBe(204);
      const before = (await readExpense(ada.token, id)).json();
      await app.stop();

      app = await createApplication({ databaseUrl });
      expect((await readExpense(ada.token, id)).json()).toEqual(before);
      expect(before.version).toBe(2);
    });

    it('keeps a deletion when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token })).statusCode).toBe(204);
      await app.stop();

      app = await createApplication({ databaseUrl });
      expect((await readExpense(ada.token, id)).statusCode).toBe(404);
      expect((await balancesOf(ada.token, groupId)).every(balance => balance.balance === 0)).toBe(true);
    });
  });
});
