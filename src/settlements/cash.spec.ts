import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe('settling up in cash', () => {
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
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
  }

  async function settle(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/settlements/cash`, { token, payload });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  /**
   * Ada owns a group with Grace and Linus in it, in that order. Grace paid 1000 split between Ada and
   * Grace, so Ada owes Grace 500: Ada's balance is -500, Grace's 500, Linus's 0.
   */
  async function adaOwesGrace() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    const expense = await record(grace.token, groupId, {
      description: 'Dinner',
      amount: 1000,
      date: todayInUtc(),
      splitBetween: [ada.id, grace.id],
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, linus, groupId };
  }

  describe('recording a settlement', () => {
    it('is recorded by the payee, who is the caller, and answers its id with 201', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const response = await settle(grace.token, groupId, { from: ada.id, amount: 300 });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: expect.any(String) });
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { ada, groupId } = await adaOwesGrace();
      const payload = { from: ada.id, amount: 300 };
      expect((await send(app, 'POST', `/groups/${groupId}/settlements/cash`, { payload })).statusCode).toBe(401);
      expect(
        (await send(app, 'POST', `/groups/${groupId}/settlements/cash`, { token: 'nonsense', payload })).statusCode,
      ).toBe(401);
    });

    it('answers 404 to a person who is not a member, the same as for a group that does not exist', async () => {
      const { ada, groupId } = await adaOwesGrace();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const payload = { from: ada.id, amount: 300 };
      const outsider = await settle(eve.token, groupId, payload);
      const missing = await settle(eve.token, 'no-such-group', payload);
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
    });

    it('refuses a payer who is not a member of the group with 422, and writes nothing', async () => {
      const { grace, groupId } = await adaOwesGrace();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const response = await settle(grace.token, groupId, { from: eve.id, amount: 100 });
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('NotAMember');
    });

    it('refuses a settlement to oneself with 422', async () => {
      const { grace, groupId } = await adaOwesGrace();
      const response = await settle(grace.token, groupId, { from: grace.id, amount: 100 });
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('SettlementToSelf');
    });

    it('refuses an amount that is not a whole number at least 1 with 422, and a string with 400', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      for (const amount of [0, -5, 1.5]) {
        const response = await settle(grace.token, groupId, { from: ada.id, amount });
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidAmount');
      }
      const asString = await settle(grace.token, groupId, { from: ada.id, amount: '300' });
      expect(asString.statusCode).toBe(400);
    });

    it('refuses more than the payer owes with 409, and nothing changes', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const before = await balancesOf(ada.token, groupId);
      const response = await settle(grace.token, groupId, { from: ada.id, amount: 501 });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ type: 'MoreThanIsOwed', message: expect.any(String) });
      expect(await balancesOf(ada.token, groupId)).toEqual(before);
    });

    it('refuses a payer who owes nothing, and a payee who is owed nothing, with 409', async () => {
      const { ada, grace, linus, groupId } = await adaOwesGrace();
      // Grace pays nothing to anyone she is owed by, Linus owes nothing: Linus is not owed by Ada either.
      const payerOwesNothing = await settle(grace.token, groupId, { from: linus.id, amount: 1 });
      expect(payerOwesNothing.statusCode).toBe(409);
      // Ada owes 500, but Linus is owed nothing, so he cannot be paid.
      const payeeIsOwedNothing = await settle(linus.token, groupId, { from: ada.id, amount: 1 });
      expect(payeeIsOwedNothing.statusCode).toBe(409);
      expect(payeeIsOwedNothing.json().type).toBe('MoreThanIsOwed');
      expect((await balancesOf(ada.token, groupId))[0].balance).toBe(-500);
    });

    it('accepts exactly what is owed, which leaves both balances at 0', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      expect((await settle(grace.token, groupId, { from: ada.id, amount: 500 })).statusCode).toBe(201);
      const balances = await balancesOf(ada.token, groupId);
      expect(balances).toEqual([
        { memberId: ada.id, balance: 0 },
        { memberId: grace.id, balance: 0 },
        expect.objectContaining({ balance: 0 }),
      ]);
    });

    it('refuses a second settlement for what the first has already paid, once the balances have moved', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      expect((await settle(grace.token, groupId, { from: ada.id, amount: 300 })).statusCode).toBe(201);
      // Ada owes 200 now: 300 is refused, 200 is accepted.
      expect((await settle(grace.token, groupId, { from: ada.id, amount: 300 })).statusCode).toBe(409);
      expect((await settle(grace.token, groupId, { from: ada.id, amount: 200 })).statusCode).toBe(201);
    });
  });

  describe('what it changes', () => {
    it('raises the payer’s balance and lowers the payee’s by its amount, and the balances still add up to 0', async () => {
      const { ada, grace, linus, groupId } = await adaOwesGrace();
      await settle(grace.token, groupId, { from: ada.id, amount: 300 });
      const balances = await balancesOf(ada.token, groupId);
      expect(balances).toEqual([
        { memberId: ada.id, balance: -200 },
        { memberId: grace.id, balance: 200 },
        { memberId: linus.id, balance: 0 },
      ]);
      expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
    });

    it('is counted at once by the suggested settlements', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await settle(grace.token, groupId, { from: ada.id, amount: 300 });
      const suggested = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ada.token });
      expect(suggested.json()).toEqual([{ from: ada.id, to: grace.id, amount: 200 }]);

      await settle(grace.token, groupId, { from: ada.id, amount: 200 });
      const after = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ada.token });
      expect(after.json()).toEqual([]);
    });

    it('lets a payer leave at once, still owing, and the owner takes over what they owed', async () => {
      // Linus, a plain member (the owner may not leave), owes Grace 300 for a taxi they split.
      const { ada, grace, linus, groupId } = await adaOwesGrace();
      const taxi = await record(grace.token, groupId, {
        description: 'Taxi',
        amount: 600,
        date: todayInUtc(),
        splitBetween: [grace.id, linus.id],
      });
      expect(taxi.statusCode).toBe(201);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: linus.token })).statusCode).toBe(204);
      // Ada owed Grace 500 and now also what Linus owed: 800. Grace is still owed 800; the balances add up to 0.
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: -800 },
        { memberId: grace.id, balance: 800 },
      ]);
    });

    it("lists the settlement in the payer's statement, as an entry of its own, and the balance is the group's", async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = (await settle(grace.token, groupId, { from: ada.id, amount: 500 })).json().id;
      const statement = await send(app, 'GET', `/groups/${groupId}/members/${ada.id}/statement`, {
        token: ada.token,
      });
      expect(statement.statusCode).toBe(200);
      expect(statement.json().entries).toEqual([
        expect.objectContaining({ kind: 'expense', paid: 0, share: 500, balance: -500 }),
        expect.objectContaining({
          kind: 'settlement',
          settlementId: id,
          description: 'Settlement in cash',
          paid: 500,
          share: 0,
          balance: 0,
        }),
      ]);
      expect(statement.json().balance).toBe(0);
      expect((await balancesOf(ada.token, groupId)).find(b => b.memberId === ada.id)?.balance).toBe(0);
    });
  });

  describe('reading a settlement', () => {
    async function recorded() {
      const found = await adaOwesGrace();
      const id = (await settle(found.grace.token, found.groupId, { from: found.ada.id, amount: 300 })).json().id;
      return { ...found, id };
    }

    it('answers its group, payer, payee, amount, cash, paid and when it was recorded', async () => {
      const { ada, grace, groupId, id } = await recorded();
      const response = await send(app, 'GET', `/settlements/${id}`, { token: grace.token });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        id,
        groupId,
        from: ada.id,
        to: grace.id,
        amount: 300,
        method: 'cash',
        status: 'paid',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/),
        history: [{ status: 'paid', at: expect.any(String) }],
      });
      expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    });

    it('answers the same settlement to every member of the group, the payer included', async () => {
      const { ada, linus, grace, id } = await recorded();
      const fromGrace = await send(app, 'GET', `/settlements/${id}`, { token: grace.token });
      expect((await send(app, 'GET', `/settlements/${id}`, { token: ada.token })).json()).toEqual(fromGrace.json());
      expect((await send(app, 'GET', `/settlements/${id}`, { token: linus.token })).json()).toEqual(fromGrace.json());
    });

    it('answers 404 to a signed-in person who is not a member, as if the settlement did not exist', async () => {
      const { groupId, id } = await recorded();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const outsider = await send(app, 'GET', `/settlements/${id}`, { token: eve.token });
      const missing = await send(app, 'GET', '/settlements/no-such-settlement', { token: eve.token });
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
      expect(groupId).toBeDefined();
    });

    it('answers 401 to a request with no token', async () => {
      const { id } = await recorded();
      expect((await send(app, 'GET', `/settlements/${id}`)).statusCode).toBe(401);
    });
  });

  describe('at the same moment', () => {
    it('decides one of two settlements recorded at once on two applications of the same file: one is kept', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const other = await createApplication({ databasePath });
      try {
        const [first, second] = await Promise.all([
          send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
            token: grace.token,
            payload: { from: ada.id, amount: 500 },
          }),
          send(other, 'POST', `/groups/${groupId}/settlements/cash`, {
            token: grace.token,
            payload: { from: ada.id, amount: 500 },
          }),
        ]);
        expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
        expect((await balancesOf(ada.token, groupId))[0].balance).toBe(0);
      } finally {
        await other.stop();
      }
    });
  });

  describe('what is kept', () => {
    it('keeps a settlement, and what it did to the balances, when the application stops and starts again', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = (await settle(grace.token, groupId, { from: ada.id, amount: 300 })).json().id;
      await app.stop();

      app = await createApplication({ databasePath });
      const read = await send(app, 'GET', `/settlements/${id}`, { token: grace.token });
      expect(read.statusCode).toBe(200);
      expect(read.json().amount).toBe(300);
      expect((await balancesOf(ada.token, groupId))[0].balance).toBe(-200);
    });
  });
});
