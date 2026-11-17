import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { todayInUtc } from '../expenses/validation';

describe('balances', () => {
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

  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response;
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

  async function balancesOf(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/balances`, { token });
  }

  const expense = (amount: number, splitBetween: string[]) => ({
    description: 'Groceries',
    amount,
    date: todayInUtc(),
    splitBetween,
  });

  describe("a member's balance", () => {
    it('is what they paid minus their shares: positive for the payer, negative for those who owe', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      // 1000 split three ways: Ada's share is 334 (the remainder goes to her), the others 333.
      await record(ada.token, groupId, expense(1000, [ada.id, grace.id, linus.id]));
      const response = await balancesOf(ada.token, groupId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { memberId: ada.id, balance: 666 },
        { memberId: grace.id, balance: -333 },
        { memberId: linus.id, balance: -333 },
      ]);
    });

    it('is 0 for a member who has recorded nothing and is in no split', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(ada.token, groupId, expense(500, [ada.id, grace.id]));
      const balances = (await balancesOf(linus.token, groupId)).json<{ memberId: string; balance: number }[]>();
      expect(balances.find(balance => balance.memberId === linus.id)).toEqual({ memberId: linus.id, balance: 0 });
    });

    it('is 0 for everyone in a group that has no expenses yet', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const response = await balancesOf(grace.token, groupId);
      expect(response.json()).toEqual([
        { memberId: ada.id, balance: 0 },
        { memberId: grace.id, balance: 0 },
        { memberId: linus.id, balance: 0 },
      ]);
    });

    it('nets out over every expense of the group, whoever paid them', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(ada.token, groupId, expense(300, [ada.id, grace.id, linus.id]));
      await record(grace.token, groupId, expense(600, [grace.id, linus.id]));
      await record(linus.token, groupId, expense(900, [ada.id, grace.id, linus.id]));
      // Ada: paid 300, shares in the first and last (100 + 300) → -100.
      // Grace: paid 600, shares in all three (100 + 300 + 300) → -100.
      // Linus: paid 900, shares in all three (100 + 300 + 300) → +200.
      const balances = (await balancesOf(ada.token, groupId)).json<{ memberId: string; balance: number }[]>();
      expect(balances).toEqual([
        { memberId: ada.id, balance: 300 - (100 + 300) },
        { memberId: grace.id, balance: 600 - (100 + 300 + 300) },
        { memberId: linus.id, balance: 900 - (100 + 300 + 300) },
      ]);
    });

    it('is the same to every member, and the same on every read', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(grace.token, groupId, expense(700, [ada.id, grace.id]));
      const first = (await balancesOf(ada.token, groupId)).json();
      expect((await balancesOf(grace.token, groupId)).json()).toEqual(first);
      expect((await balancesOf(ada.token, groupId)).json()).toEqual(first);
    });
  });

  describe('the order of the balances', () => {
    it('lists every member in the order they joined, the earliest first, whatever their balance', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      // Linus records an expense first: his balance does not move him up the list.
      await record(linus.token, groupId, expense(900, [linus.id]));
      const members = (await balancesOf(ada.token, groupId)).json<{ memberId: string }[]>();
      expect(members.map(member => member.memberId)).toEqual([ada.id, grace.id, linus.id]);
    });

    it('answers only the memberId and balance of each member', async () => {
      const { ada, groupId } = await threeMembers();
      const [first] = (await balancesOf(ada.token, groupId)).json<Record<string, unknown>[]>();
      expect(Object.keys(first).sort()).toEqual(['balance', 'memberId']);
    });
  });

  describe('the zero sum', () => {
    it('adds up to 0 after any sequence of expenses, including one split with a remainder', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(grace.token, groupId, expense(1, [ada.id, grace.id, linus.id]));
      await record(ada.token, groupId, expense(99_999_999, [ada.id, grace.id, linus.id]));
      await record(linus.token, groupId, expense(12_345, [grace.id, linus.id]));
      const balances = (await balancesOf(ada.token, groupId)).json<{ balance: number }[]>();
      expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
    });

    it('still adds up to 0 when several servers on one file record expenses, each counted once', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
      const groupId = await createdGroup(ada.token);
      await joinThroughInvitation(app, ada.token, grace.token, groupId);
      await joinThroughInvitation(app, ada.token, linus.token, groupId);

      // A second application on the same file, the way a second server would be.
      const other = await createApplication({ databasePath });
      try {
        // Six expenses of 300, each split three ways (100 each), recorded at the same moment from
        // both applications. Ada pays three, Grace two, Linus one.
        const payers = [ada, grace, ada, linus, ada, grace];
        const servers = [app, other];
        const responses = await Promise.all(
          payers.map((payer, index) =>
            send(servers[index % 2], 'POST', `/groups/${groupId}/expenses`, {
              token: payer.token,
              payload: expense(300, [ada.id, grace.id, linus.id]),
            }),
          ),
        );
        responses.forEach(response => expect(response.statusCode).toBe(201));
        expect(new Set(responses.map(response => response.json<{ id: string }>().id)).size).toBe(6);

        const balances = (await send(other, 'GET', `/groups/${groupId}/balances`, { token: ada.token })).json<
          { memberId: string; balance: number }[]
        >();
        // Ada: paid 900, shares 600 → 300. Grace: paid 600, shares 600 → 0. Linus: paid 300, shares 600 → -300.
        expect(balances).toEqual([
          { memberId: ada.id, balance: 300 },
          { memberId: grace.id, balance: 0 },
          { memberId: linus.id, balance: -300 },
        ]);
      } finally {
        await other.stop();
      }
    });
  });

  describe('who reads them', () => {
    it('answers 404 to a signed-in person who is not a member, as if the group did not exist', async () => {
      const { groupId } = await threeMembers();
      const outsider = await signedUpAccount(app, { email: 'outsider@example.com', name: 'Eve' });
      const refused = await balancesOf(outsider.token, groupId);
      const missing = await balancesOf(outsider.token, 'no-such-group');
      expect(refused.statusCode).toBe(404);
      expect(refused.json().type).toBe('NotFound');
      expect(refused.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { groupId } = await threeMembers();
      expect((await send(app, 'GET', `/groups/${groupId}/balances`)).statusCode).toBe(401);
      expect((await balancesOf('not-a-real-token', groupId)).statusCode).toBe(401);
    });
  });

  describe('what is kept', () => {
    it('keeps the balances when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, expense(1000, [ada.id, grace.id]));
      const before = (await balancesOf(ada.token, groupId)).json();
      await app.stop();

      app = await createApplication({ databasePath });
      expect((await balancesOf(ada.token, groupId)).json()).toEqual(before);
    });
  });
});
