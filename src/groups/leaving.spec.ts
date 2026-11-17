import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe('leaving a group', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** An expense body as recorded, split equally between `splitBetween`. */
  const expense = (splitBetween: string[], overrides: Record<string, unknown> = {}) => ({
    description: 'Groceries',
    amount: 1000,
    date: todayInUtc(),
    splitBetween,
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function leave(token: string, groupId: string) {
    return send(app, 'POST', `/groups/${groupId}/leave`, { token });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  async function membersOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/members`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; name: string; role: string; joinedAt: string }[]>();
  }

  /**
   * Ada owns a group with Grace and Linus in it, in that order. Grace and Ada have paid one expense
   * each, of 1000 split between the two of them, so Grace's balance is 0 and she may leave.
   */
  async function settledGrace() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    const first = await record(grace.token, groupId, expense([grace.id, ada.id]));
    const second = await record(ada.token, groupId, expense([ada.id, grace.id]));
    return { ada, grace, linus, groupId, first, second };
  }

  describe('leaving', () => {
    it('lets a member whose balance is 0 leave, answering 204', async () => {
      const { grace, groupId } = await settledGrace();
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);
    });

    it('takes the group away from the one who left: it is not theirs any more, as for anyone who is not a member', async () => {
      const { ada, grace, groupId } = await settledGrace();
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);

      const read = await send(app, 'GET', `/groups/${groupId}`, { token: grace.token });
      const missing = await send(app, 'GET', '/groups/no-such-group', { token: grace.token });
      expect(read.statusCode).toBe(404);
      expect(read.json()).toEqual(missing.json());

      expect((await send(app, 'GET', `/groups/${groupId}/members`, { token: grace.token })).statusCode).toBe(404);
      expect((await send(app, 'GET', `/groups/${groupId}/balances`, { token: grace.token })).statusCode).toBe(404);
      expect((await send(app, 'GET', `/groups/${groupId}/expenses`, { token: grace.token })).statusCode).toBe(404);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token })).statusCode).toBe(404);
      expect((await send(app, 'GET', '/groups/mine', { token: grace.token })).json()).toEqual([]);
      expect((await send(app, 'GET', `/groups/${groupId}`, { token: ada.token })).statusCode).toBe(200);
    });

    it('takes the one who left out of the members and the balances, which still add up to 0', async () => {
      const { ada, grace, linus, groupId } = await settledGrace();
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);

      expect((await membersOf(ada.token, groupId)).map(member => member.memberId)).toEqual([ada.id, linus.id]);
      const balances = await balancesOf(ada.token, groupId);
      expect(balances).toEqual([
        { memberId: ada.id, balance: 0 },
        { memberId: linus.id, balance: 0 },
      ]);
      expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
    });

    it('refuses the owner, with 403, who stays in the group', async () => {
      const { ada, groupId } = await settledGrace();
      const response = await leave(ada.token, groupId);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ type: 'OwnerCannotLeave', message: expect.any(String) });
      expect((await membersOf(ada.token, groupId))[0]).toEqual(
        expect.objectContaining({ memberId: ada.id, role: 'owner' }),
      );
    });

    it('answers 404 to a person who is not a member, the same as a group that does not exist', async () => {
      const { ada, groupId } = await settledGrace();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const outsider = await leave(eve.token, groupId);
      const missing = await leave(eve.token, 'no-such-group');
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json().type).toBe('NotFound');
      expect(outsider.json()).toEqual(missing.json());
      expect((await membersOf(ada.token, groupId)).length).toBe(3);
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { groupId } = await settledGrace();
      expect((await send(app, 'POST', `/groups/${groupId}/leave`)).statusCode).toBe(401);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: 'not-a-real-token' })).statusCode).toBe(401);
    });

    it('answers 404 to leaving a second time', async () => {
      const { grace, groupId } = await settledGrace();
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);
      const again = await leave(grace.token, groupId);
      expect(again.statusCode).toBe(404);
      expect(again.json().type).toBe('NotFound');
    });
  });

  describe('after leaving', () => {
    it('refuses a new expense that puts the one who left in its split, with 422', async () => {
      const { ada, grace, groupId } = await settledGrace();
      await leave(grace.token, groupId);
      const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ada.token,
        payload: expense([ada.id, grace.id]),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('NotAMember');
    });

    it('refuses a new expense paid by the one who left, with 404, as for a group they are not in', async () => {
      const { ada, grace, groupId } = await settledGrace();
      await leave(grace.token, groupId);
      const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: grace.token,
        payload: expense([ada.id]),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().type).toBe('NotFound');
    });

    it('keeps the expenses they were in as they were, with their shares, for the members to read', async () => {
      const { ada, grace, groupId, first, second } = await settledGrace();
      const before = (await send(app, 'GET', `/expenses/${first}`, { token: ada.token })).json();
      await leave(grace.token, groupId);

      const read = await send(app, 'GET', `/expenses/${first}`, { token: ada.token });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(before);
      expect(read.json().shares).toEqual([
        { memberId: grace.id, amount: 500 },
        { memberId: ada.id, amount: 500 },
      ]);

      const listed = (await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ada.token })).json() as {
        id: string;
      }[];
      expect(listed.map(expenseRead => expenseRead.id).sort()).toEqual([first, second].sort());
    });

    it('lets the members read the statement of the one who left, with its entries and a balance of 0', async () => {
      const { ada, grace, groupId, first, second } = await settledGrace();
      await leave(grace.token, groupId);

      const response = await send(app, 'GET', `/groups/${groupId}/members/${grace.id}/statement`, { token: ada.token });
      expect(response.statusCode).toBe(200);
      const statement = response.json();
      expect(statement).toEqual({
        memberId: grace.id,
        balance: 0,
        entries: [
          { expenseId: first, date: todayInUtc(), description: 'Groceries', paid: 1000, share: 500, balance: 500 },
          { expenseId: second, date: todayInUtc(), description: 'Groceries', paid: 0, share: 500, balance: 0 },
        ],
      });
    });

    it('refuses the one who left their own statement, the expenses and the group, as they are not a member', async () => {
      const { grace, groupId, first } = await settledGrace();
      await leave(grace.token, groupId);
      expect(
        (await send(app, 'GET', `/groups/${groupId}/members/${grace.id}/statement`, { token: grace.token })).statusCode,
      ).toBe(404);
      expect((await send(app, 'GET', `/expenses/${first}`, { token: grace.token })).statusCode).toBe(404);
    });

    it('refuses an edit or a delete of an expense that names the one who left, with 409, and keeps it as it was', async () => {
      const { ada, grace, groupId, first, second } = await settledGrace();
      const before = (await send(app, 'GET', `/expenses/${first}`, { token: ada.token })).json();
      await leave(grace.token, groupId);

      const edited = await send(app, 'PUT', `/expenses/${first}`, {
        token: ada.token,
        payload: { ...expense([ada.id]), version: 1, amount: 400 },
      });
      expect(edited.statusCode).toBe(409);
      expect(edited.json().type).toBe('MemberHasLeft');

      const deleted = await send(app, 'DELETE', `/expenses/${second}`, { token: ada.token });
      expect(deleted.statusCode).toBe(409);
      expect(deleted.json().type).toBe('MemberHasLeft');

      expect((await send(app, 'GET', `/expenses/${first}`, { token: ada.token })).json()).toEqual(before);
      expect((await send(app, 'GET', `/expenses/${second}`, { token: ada.token })).statusCode).toBe(200);
    });

    it('still lets the members edit and delete the expenses that name only members who remain', async () => {
      const { ada, grace, linus, groupId } = await settledGrace();
      const kept = await record(ada.token, groupId, expense([ada.id, linus.id]));
      await leave(grace.token, groupId);

      const edited = await send(app, 'PUT', `/expenses/${kept}`, {
        token: ada.token,
        payload: { ...expense([ada.id, linus.id]), version: 1, amount: 800 },
      });
      expect(edited.statusCode).toBe(204);
      expect((await send(app, 'DELETE', `/expenses/${kept}`, { token: ada.token })).statusCode).toBe(204);
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 0 },
        { memberId: linus.id, balance: 0 },
      ]);
    });

    it('keeps the balances at 0 after a member leaves, whatever later expenses are recorded and deleted', async () => {
      const { ada, linus, grace, groupId } = await settledGrace();
      await leave(grace.token, groupId);
      const later = await record(linus.token, groupId, expense([linus.id, ada.id], { amount: 333 }));
      expect((await send(app, 'DELETE', `/expenses/${later}`, { token: linus.token })).statusCode).toBe(204);
      const balances = await balancesOf(ada.token, groupId);
      expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
      expect(balances.map(balance => balance.memberId)).not.toContain(grace.id);
    });
  });

  describe('coming back', () => {
    it('joins again with an invitation, as a member last in the order, with a balance of 0 and its earlier expenses kept', async () => {
      const { ada, grace, linus, groupId, first } = await settledGrace();
      await leave(grace.token, groupId);
      const statementBefore = (
        await send(app, 'GET', `/groups/${groupId}/members/${grace.id}/statement`, { token: ada.token })
      ).json();

      await joinThroughInvitation(app, ada.token, grace.token, groupId);

      const members = await membersOf(ada.token, groupId);
      expect(members.map(member => member.memberId)).toEqual([ada.id, linus.id, grace.id]);
      expect(members[2]).toEqual({
        memberId: grace.id,
        name: 'Grace',
        role: 'member',
        joinedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(Date.parse(members[2].joinedAt)).toBeGreaterThanOrEqual(Date.parse(members[1].joinedAt));
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 0 },
        { memberId: linus.id, balance: 0 },
        { memberId: grace.id, balance: 0 },
      ]);
      expect((await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).statusCode).toBe(200);
      expect((await send(app, 'GET', `/expenses/${first}`, { token: grace.token })).statusCode).toBe(200);
      expect(
        (await send(app, 'GET', `/groups/${groupId}/members/${grace.id}/statement`, { token: ada.token })).json(),
      ).toEqual(statementBefore);
    });

    it('keeps the order when someone joins straight after the one who left rejoins', async () => {
      const { ada, grace, groupId } = await settledGrace();
      await leave(grace.token, groupId);
      await joinThroughInvitation(app, ada.token, grace.token, groupId);
      const hal = await signedUpAccount(app, { email: 'hal@example.com', name: 'Hal' });
      await joinThroughInvitation(app, ada.token, hal.token, groupId);

      const names = (await membersOf(ada.token, groupId)).map(member => member.name);
      expect(names).toEqual(['Ada', 'Linus', 'Grace', 'Hal']);
    });

    it('refuses an invitation to a member who is still in the group, with 409', async () => {
      const { ada, grace, groupId } = await settledGrace();
      const created = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ada.token });
      const accepted = await send(app, 'POST', `/invitations/${created.json<{ id: string }>().id}/accept`, {
        token: grace.token,
      });
      expect(accepted.statusCode).toBe(409);
      expect(accepted.json().type).toBe('AlreadyMember');
    });

    it('lets the one who joined again leave once more, at a balance of 0', async () => {
      const { ada, grace, groupId } = await settledGrace();
      await leave(grace.token, groupId);
      await joinThroughInvitation(app, ada.token, grace.token, groupId);
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);
      expect((await membersOf(ada.token, groupId)).map(member => member.name)).toEqual(['Ada', 'Linus']);
    });
  });

  describe('what is kept', () => {
    it('keeps that a member left when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId, first } = await settledGrace();
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);
      await app.stop();

      app = await createApplication({ databasePath });
      expect((await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).statusCode).toBe(404);
      expect((await membersOf(ada.token, groupId)).map(member => member.name)).toEqual(['Ada', 'Linus']);
      expect(
        (await send(app, 'GET', `/groups/${groupId}/members/${grace.id}/statement`, { token: ada.token })).statusCode,
      ).toBe(200);
      expect((await send(app, 'GET', `/expenses/${first}`, { token: ada.token })).statusCode).toBe(200);
    });
  });
});
