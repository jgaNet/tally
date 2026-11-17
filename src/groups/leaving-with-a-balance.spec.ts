import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabasePath,
} from '../test-support';

const SECRET = 'shared-secret';

describe('leaving a group with a balance', () => {
  let app: Application;
  let databasePath: string;
  let provider: FakeProvider;

  const start = (path: string) =>
    createApplication({
      databasePath: path,
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
    });

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    provider = await startFakeProvider();
    app = await start(databasePath);
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  /** An expense body, split equally between `splitBetween`. */
  const expense = (splitBetween: string[], amount: number) => ({
    description: 'Dinner',
    amount,
    date: todayInUtc(),
    splitBetween,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<void> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
  }

  async function leave(token: string, groupId: string, server = app) {
    return send(server, 'POST', `/groups/${groupId}/leave`, { token });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  let scenarios = 0;

  /** Ada owns a group with Grace and Linus in it, in that order. Nothing is recorded yet. */
  async function threeMembers() {
    scenarios += 1;
    const ada = await signedUpAccount(app, { email: `ada${scenarios}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${scenarios}@example.com`, name: 'Grace' });
    const linus = await signedUpAccount(app, { email: `linus${scenarios}@example.com`, name: 'Linus' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  /**
   * Ada pays 900 split equally between the three of them, so Ada's balance is 600, Grace's and Linus's
   * -300 each: the example of the request, with Ada as the owner.
   */
  async function adaPaidForAll() {
    const members = await threeMembers();
    const { ada, grace, linus, groupId } = members;
    await record(ada.token, groupId, expense([ada.id, grace.id, linus.id], 900));
    expect(await balancesOf(ada.token, groupId)).toEqual([
      { memberId: ada.id, balance: 600 },
      { memberId: grace.id, balance: -300 },
      { memberId: linus.id, balance: -300 },
    ]);
    return members;
  }

  describe('leaving at once', () => {
    it('lets a member who owes the group leave at once, and the owner takes over what they owed', async () => {
      const { ada, grace, linus, groupId } = await adaPaidForAll();
      expect((await leave(linus.token, groupId)).statusCode).toBe(204);

      // Linus owed 300: Ada's balance moves by it, from 600 to 300; the balances still add up to 0.
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 300 },
        { memberId: grace.id, balance: -300 },
      ]);
    });

    it('lets a member the group owes leave at once, and the owner takes over what the group owed them', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      // Grace paid 900 split between the three: the group owes Grace 600, and Ada and Linus owe 300 each.
      await record(grace.token, groupId, expense([ada.id, grace.id, linus.id], 900));
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);

      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 300 },
        { memberId: linus.id, balance: -300 },
      ]);
    });

    it('moves the balance at once, whatever the amount, and the owner may end up owed or owing', async () => {
      const { ada, grace, linus, groupId } = await adaPaidForAll();
      // Grace owes 300, which Ada takes over: Ada was owed 600 and is owed 300 after Grace left.
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 300 },
        { memberId: linus.id, balance: -300 },
      ]);
    });

    it('has the owner take over a member’s balance when the owner was owing already', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      // Linus paid 900 split between the three: Ada and Grace owe 300 each, so Ada is owing 300.
      await record(linus.token, groupId, expense([ada.id, grace.id, linus.id], 900));
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);

      // Grace owed 300; Ada takes it over: Ada owes 600 and Linus is owed 600.
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: -600 },
        { memberId: linus.id, balance: 600 },
      ]);
    });

    it('keeps the balances adding up to 0 after a member leaves, and after expenses are recorded after that', async () => {
      const { ada, grace, linus, groupId } = await adaPaidForAll();
      expect((await leave(linus.token, groupId)).statusCode).toBe(204);
      await record(grace.token, groupId, expense([ada.id, grace.id], 400));
      const balances = await balancesOf(ada.token, groupId);
      expect(balances.map(balance => balance.memberId)).toEqual([ada.id, grace.id]);
      expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
    });
  });

  describe('coming back', () => {
    it('joins again at a balance of 0, the balance passed on not counted again, and later expenses count', async () => {
      const { ada, grace, linus, groupId } = await adaPaidForAll();
      expect((await leave(linus.token, groupId)).statusCode).toBe(204);
      await joinThroughInvitation(app, ada.token, linus.token, groupId);

      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 300 },
        { memberId: grace.id, balance: -300 },
        { memberId: linus.id, balance: 0 },
      ]);

      await record(linus.token, groupId, expense([linus.id, ada.id], 300));
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 150 },
        { memberId: grace.id, balance: -300 },
        { memberId: linus.id, balance: 150 },
      ]);
    });
  });

  describe('a payment through the provider', () => {
    /**
     * Ada owns the group with Grace in it. Ada paid 1000 split between the two: Grace owes 500. Grace asks
     * the provider to pay Ada 300, which waits at the provider; Ada has a payout account there.
     */
    async function graceOwesAndPays() {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const created = await send(app, 'POST', '/groups', {
        token: ada.token,
        payload: { name: 'Flat 4B', currency: 'EUR' },
      });
      const groupId = created.json<{ id: string }>().id;
      await joinThroughInvitation(app, ada.token, grace.token, groupId);
      await setPayoutAccount(app, ada.token, 'acct-ada');
      await record(ada.token, groupId, expense([ada.id, grace.id], 1000));
      const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: grace.token,
        payload: { to: ada.id, amount: 300 },
      });
      expect(asked.statusCode).toBe(201);
      const payment = provider.payments[provider.payments.length - 1];
      return { ada, grace, groupId, paymentId: payment.id };
    }

    /** The provider's webhook, signed as it signs them, saying the payment `status`. */
    function deliver(paymentId: string, status: string) {
      const body = `{ "id": "wh-${paymentId}-${status}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
      const signature = createHmac('sha256', SECRET).update(body).digest('hex');
      return app.server.inject({
        method: 'POST',
        url: '/v1/provider/webhooks',
        headers: { 'content-type': 'application/json', 'provider-signature': signature },
        payload: body,
      });
    }

    it('is refused while the payment waits at the provider, even at a balance that is not 0', async () => {
      const { ada, grace, groupId } = await graceOwesAndPays();
      const response = await leave(grace.token, groupId);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('PaymentPending');
      expect((await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).statusCode).toBe(200);
      expect((await balancesOf(ada.token, groupId)).find(balance => balance.memberId === grace.id)?.balance).toBe(-500);
    });

    it('lets the member leave once the payment has succeeded, and passes what they still owe on to the owner', async () => {
      const { ada, grace, groupId, paymentId } = await graceOwesAndPays();
      expect((await leave(grace.token, groupId)).json().type).toBe('PaymentPending');
      expect((await deliver(paymentId, 'succeeded')).statusCode).toBeLessThan(300);

      // Grace is now owing 200 (500 less the 300 paid): Ada takes those 200 over, and is at 0.
      expect((await leave(grace.token, groupId)).statusCode).toBe(204);
      expect(await balancesOf(ada.token, groupId)).toEqual([{ memberId: ada.id, balance: 0 }]);
    });
  });

  describe('at the moment someone leaves', () => {
    it('records an expense before the leave, or refuses it because the one who left is not a member: the balances add up to 0', async () => {
      const outcomes = new Set<number>();
      for (let round = 0; round < 6; round++) {
        const { ada, grace, linus, groupId } = await adaPaidForAll();
        const other = await start(databasePath);
        // Linus leaves while Ada records an expense of 300 that names Linus, through the other server.
        const [left, recorded] = await Promise.all([
          leave(linus.token, groupId, round % 2 === 0 ? app : other),
          send(round % 2 === 0 ? other : app, 'POST', `/groups/${groupId}/expenses`, {
            token: ada.token,
            payload: expense([ada.id, grace.id, linus.id], 300),
          }),
        ]);
        await other.stop();
        expect(left.statusCode).toBe(204);
        outcomes.add(recorded.statusCode);

        const balances = await balancesOf(ada.token, groupId);
        expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
        expect(balances.map(balance => balance.memberId)).not.toContain(linus.id);
        if (recorded.statusCode === 201) {
          // Counted before the leave: Ada paid 300 for three, so her share is 100 and Linus's 100 passes to her.
          expect(balances).toEqual([
            { memberId: ada.id, balance: 400 },
            { memberId: grace.id, balance: -400 },
          ]);
        } else {
          expect(recorded.statusCode).toBe(422);
          expect(recorded.json().type).toBe('NotAMember');
          expect(balances).toEqual([
            { memberId: ada.id, balance: 300 },
            { memberId: grace.id, balance: -300 },
          ]);
        }
        await app.stop();
        app = await start(databasePath);
      }
      expect([...outcomes].every(status => status === 201 || status === 422)).toBe(true);
    });

    it('records a cash settlement before the leave, or refuses it because the payer is not a member: the balances add up to 0', async () => {
      const { ada, grace, linus, groupId } = await adaPaidForAll();
      const other = await start(databasePath);
      // Linus pays Ada 300 in cash, recorded by Ada, while Linus leaves: either order ends the same.
      const [left, settled] = await Promise.all([
        leave(linus.token, groupId, other),
        send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: ada.token,
          payload: { from: linus.id, amount: 300 },
        }),
      ]);
      await other.stop();
      expect(left.statusCode).toBe(204);
      expect([201, 422]).toContain(settled.statusCode);
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 300 },
        { memberId: grace.id, balance: -300 },
      ]);
    });
  });

  describe('what is kept', () => {
    it('keeps the balance passed on when the application stops and starts again on the same file', async () => {
      const { ada, grace, linus, groupId } = await adaPaidForAll();
      expect((await leave(linus.token, groupId)).statusCode).toBe(204);
      await app.stop();

      app = await start(databasePath);
      expect(await balancesOf(ada.token, groupId)).toEqual([
        { memberId: ada.id, balance: 300 },
        { memberId: grace.id, balance: -300 },
      ]);
    });
  });
});
