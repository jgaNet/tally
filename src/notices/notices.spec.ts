import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { todayInUtc } from '../expenses/validation';

describe('notices', () => {
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

  /** Ada owns a group with Grace and Linus in it; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  const expense = (overrides: Record<string, unknown> = {}) => ({
    description: 'Pizzas',
    amount: 1000,
    date: todayInUtc(),
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function noticesOf(token: string) {
    const response = await send(app, 'GET', '/notices', { token });
    expect(response.statusCode).toBe(200);
    return response.json<
      { id: string; kind: string; groupId: string; expenseId: string; amount: number; at: string }[]
    >();
  }

  describe('when an expense is recorded', () => {
    it('gives each member of the split but the payer a notice with their share, at once', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const expenseId = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id, linus.id] }));

      // Visible straight after the request answers: no background job is waited for.
      const graceNotices = await noticesOf(grace.token);
      expect(graceNotices).toEqual([
        {
          id: expect.any(String),
          kind: 'expense',
          groupId,
          expenseId,
          amount: 333,
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/),
        },
      ]);
      // The remainder of the split is in the first member's share, which is the payer's: Grace has 333.
      const linusNotices = await noticesOf(linus.token);
      expect(linusNotices).toHaveLength(1);
      expect(linusNotices[0]).toMatchObject({ kind: 'expense', groupId, expenseId, amount: 333 });
    });

    it('gives the payer no notice, though the payer is in the split', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      expect(await noticesOf(ada.token)).toEqual([]);
      expect(await noticesOf(grace.token)).toHaveLength(1);
    });

    it('gives the payer no notice when another member paid, and one to each other member of the split', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(grace.token, groupId, expense({ splitBetween: [ada.id, grace.id, linus.id] }));
      expect(await noticesOf(grace.token)).toEqual([]);
      expect(await noticesOf(ada.token)).toHaveLength(1);
      expect(await noticesOf(linus.token)).toHaveLength(1);
    });

    it('gives the share each member has in an exact split, and in a split by shares', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const exactId = await record(
        ada.token,
        groupId,
        expense({
          splitExactly: [
            { memberId: ada.id, amount: 200 },
            { memberId: grace.id, amount: 300 },
            { memberId: linus.id, amount: 500 },
          ],
        }),
      );
      const sharesId = await record(
        ada.token,
        groupId,
        expense({
          amount: 900,
          splitByShares: [
            { memberId: ada.id, shares: 1 },
            { memberId: grace.id, shares: 1 },
            { memberId: linus.id, shares: 2 },
          ],
        }),
      );
      const graceNotices = await noticesOf(grace.token);
      expect(graceNotices.map(n => [n.expenseId, n.amount])).toEqual([
        [sharesId, 225],
        [exactId, 300],
      ]);
      const linusNotices = await noticesOf(linus.token);
      expect(linusNotices.map(n => [n.expenseId, n.amount])).toEqual([
        [sharesId, 450],
        [exactId, 500],
      ]);
    });

    it('gives one notice per member per expense, however many expenses are recorded', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      const notices = await noticesOf(grace.token);
      expect(notices).toHaveLength(2);
      expect(new Set(notices.map(n => n.expenseId)).size).toBe(2);
    });

    it('makes no notice for a refused expense, so a member is never told of one that was not kept', async () => {
      const { ada, grace, groupId } = await threeMembers();
      // Grace is not named in a split that does not add up: the expense is refused, and nothing is written.
      const refused = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ada.token,
        payload: {
          description: 'Pizzas',
          amount: 1000,
          date: todayInUtc(),
          splitExactly: [
            { memberId: ada.id, amount: 1 },
            { memberId: grace.id, amount: 1 },
          ],
        },
      });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(await noticesOf(grace.token)).toEqual([]);
    });
  });

  describe('when an expense is edited or deleted', () => {
    it('makes no notice, and keeps the one made when it was recorded', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const expenseId = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      const [before] = await noticesOf(grace.token);

      const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: ada.token,
        payload: {
          description: 'Pizzas',
          amount: 4000,
          date: todayInUtc(),
          version: 1,
          splitBetween: [ada.id, grace.id],
        },
      });
      expect(edited.statusCode).toBe(204);
      expect(await noticesOf(grace.token)).toEqual([before]);

      const deleted = await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ada.token });
      expect(deleted.statusCode).toBe(204);
      expect(await noticesOf(grace.token)).toEqual([before]);
    });
  });

  describe('reading them', () => {
    it('lists the signed-in account’s own notices, the most recent first', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const first = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id], description: 'A' }));
      const second = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id], description: 'B' }));
      const third = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id], description: 'C' }));
      const notices = await noticesOf(grace.token);
      expect(notices.map(n => n.expenseId)).toEqual([third, second, first]);
      const ats = notices.map(n => n.at);
      expect([...ats].sort().reverse()).toEqual(ats);
    });

    it('shows each member only their own notices', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      await record(ada.token, groupId, expense({ splitBetween: [ada.id, linus.id] }));
      expect(await noticesOf(grace.token)).toHaveLength(1);
      expect(await noticesOf(linus.token)).toHaveLength(1);
      expect(await noticesOf(ada.token)).toEqual([]);
    });

    it('answers an empty list to an account with no notices', async () => {
      const lonely = await signedUpAccount(app, { email: 'lonely@example.com', name: 'Lonely' });
      expect(await noticesOf(lonely.token)).toEqual([]);
    });

    it('refuses a request that is not signed in', async () => {
      const response = await send(app, 'GET', '/notices');
      expect(response.statusCode).toBe(401);
    });

    it('keeps a notice after its member leaves the group', async () => {
      const { ada, linus, groupId } = await threeMembers();
      const expenseId = await record(ada.token, groupId, expense({ splitBetween: [ada.id, linus.id] }));
      // Linus owes 500; Ada, the payee, records the cash that settles it, so Linus's balance is 0 and he may leave.
      const settled = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ada.token,
        payload: { from: linus.id, amount: 500 },
      });
      expect(settled.statusCode).toBe(201);
      const left = await send(app, 'POST', `/groups/${groupId}/leave`, { token: linus.token });
      expect(left.statusCode).toBeLessThan(300);

      const notices = await noticesOf(linus.token);
      expect(notices).toEqual([expect.objectContaining({ groupId, expenseId, amount: 500 })]);
    });

    it('is only read; reading changes nothing', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
      const once = await noticesOf(grace.token);
      const twice = await noticesOf(grace.token);
      expect(twice).toEqual(once);
    });
  });

  it('keeps every notice, once each, when the application stops and starts again on the same file', async () => {
    const { ada, grace, linus, groupId } = await threeMembers();
    const expenseId = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id, linus.id] }));
    const before = await noticesOf(grace.token);
    await app.stop();

    app = await createApplication({ databasePath });
    expect(await noticesOf(grace.token)).toEqual(before);
    expect(await noticesOf(linus.token)).toEqual([expect.objectContaining({ expenseId, amount: 333 })]);
    expect(await noticesOf(ada.token)).toEqual([]);
  });
});
