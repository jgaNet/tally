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

interface Netting {
  id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}

// Amounts are in hundredths of the group's currency: 300 euros is 30000.
describe('netting what two people owe each other across their groups', () => {
  let app: Application;
  let provider: FakeProvider;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    app = await createApplication({ databaseUrl, providerUrl: provider.url, providerTimeoutMs: 300 });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  async function person(name: string): Promise<Who> {
    return signedUpAccount(app, { email: `${name.toLowerCase()}@example.com`, name });
  }

  /** A group owned by `owner`, which `member` joins. */
  async function groupWith(owner: Who, member: Who, currency = 'EUR'): Promise<string> {
    const created = await send(app, 'POST', '/groups', { token: owner.token, payload: { name: 'Group', currency } });
    expect(created.statusCode).toBe(201);
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, owner.token, member.token, groupId);
    return groupId;
  }

  /** An expense `payer` records in `groupId`, split between `splitBetween`. */
  async function spend(payer: Who, groupId: string, amount: number, splitBetween: string[]): Promise<void> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: payer.token,
      payload: { description: 'Shared', amount, date: todayInUtc(), splitBetween },
    });
    expect(response.statusCode).toBe(201);
  }

  async function netting(token: string, withId: string, currency = 'EUR', on: Application = app) {
    return send(on, 'POST', '/nettings', { token, payload: { with: withId, currency } });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  /**
   * Ann and Bob, with three groups in EUR, created in this order: in the flat Ann owes Bob 300, in the trip (created
   * later) Ann owes Bob 200, and in the club Bob owes Ann 400. So Ann can pay Bob 500, Bob can pay Ann 400.
   */
  async function annAndBob() {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const flat = await groupWith(ann, bob);
    await spend(bob, flat, 60000, [ann.id, bob.id]);
    const trip = await groupWith(ann, bob);
    await spend(bob, trip, 40000, [ann.id, bob.id]);
    const club = await groupWith(ann, bob);
    await spend(ann, club, 80000, [ann.id, bob.id]);
    return { ann, bob, flat, trip, club };
  }

  it('nets 400 across the groups as settlements that count at once, the caller paying first', async () => {
    const { ann, bob, flat, trip, club } = await annAndBob();

    const response = await netting(ann.token, bob.id);
    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();

    const read = await send(app, 'GET', `/nettings/${id}`, { token: ann.token });
    expect(read.statusCode).toBe(200);
    const netted = read.json<Netting>();
    expect(netted).toEqual({
      id,
      by: ann.id,
      with: bob.id,
      currency: 'EUR',
      amount: 40000,
      settlements: [expect.any(String), expect.any(String), expect.any(String)],
    });

    // Ann pays Bob 300 in the flat and 100 in the trip; Bob pays Ann 400 in the club.
    const [first, second, third] = await Promise.all(
      netted.settlements.map(async settlementId => {
        const settled = await send(app, 'GET', `/settlements/${settlementId}`, { token: ann.token });
        expect(settled.statusCode).toBe(200);
        return settled.json();
      }),
    );
    expect(first).toEqual(
      expect.objectContaining({
        groupId: flat,
        from: ann.id,
        to: bob.id,
        amount: 30000,
        method: 'net',
        status: 'paid',
        history: [{ status: 'paid', at: expect.any(String) }],
      }),
    );
    expect(second).toEqual(
      expect.objectContaining({ groupId: trip, from: ann.id, to: bob.id, amount: 10000, method: 'net' }),
    );
    expect(third).toEqual(
      expect.objectContaining({ groupId: club, from: bob.id, to: ann.id, amount: 40000, method: 'net' }),
    );
    expect(first).not.toHaveProperty('payUrl');
  });

  it('counts the netted settlements in the balances, the statement and the audit at once', async () => {
    const { ann, bob, flat, trip, club } = await annAndBob();
    const { id } = (await netting(ann.token, bob.id)).json<{ id: string }>();
    const { settlements } = (await send(app, 'GET', `/nettings/${id}`, { token: ann.token })).json<Netting>();

    expect(await balancesOf(ann.token, flat)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
    expect(await balancesOf(ann.token, trip)).toEqual([
      { memberId: ann.id, balance: -10000 },
      { memberId: bob.id, balance: 10000 },
    ]);
    expect(await balancesOf(ann.token, club)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    const statement = await send(app, 'GET', `/groups/${flat}/members/${ann.id}/statement`, { token: ann.token });
    expect(statement.statusCode).toBe(200);
    expect(statement.json<{ entries: unknown[] }>().entries).toContainEqual(
      expect.objectContaining({
        kind: 'settlement',
        settlementId: settlements[0],
        description: 'Settlement by netting',
      }),
    );

    const audit = await send(app, 'GET', `/groups/${flat}/audit`, { token: bob.token });
    expect(audit.json<unknown[]>()).toContainEqual(
      expect.objectContaining({ by: ann.id, action: 'settlement-paid', subjectId: settlements[0], amount: 30000 }),
    );
  });

  it('is read by the two members only, and does not exist for anyone else', async () => {
    const { ann, bob } = await annAndBob();
    const { id } = (await netting(ann.token, bob.id)).json<{ id: string }>();
    const eve = await person('Eve');

    expect((await send(app, 'GET', `/nettings/${id}`, { token: bob.token })).statusCode).toBe(200);
    const outsider = await send(app, 'GET', `/nettings/${id}`, { token: eve.token });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual({ type: 'NotFound', message: expect.any(String) });
    expect((await send(app, 'GET', `/nettings/${id}`)).statusCode).toBe(401);
  });

  it('is refused with oneself, in a currency that is not Tally’s, and with nothing to net, changing nothing', async () => {
    const { ann, bob, flat } = await annAndBob();
    const eve = await person('Eve');

    const self = await netting(ann.token, ann.id);
    expect(self.statusCode).toBe(422);
    expect(self.json()).toEqual({ type: 'NettingWithSelf', message: expect.any(String) });

    const unknownCurrency = await netting(ann.token, bob.id, 'JPY');
    expect(unknownCurrency.statusCode).toBe(422);
    expect(unknownCurrency.json()).toEqual({ type: 'InvalidCurrency', message: expect.any(String) });

    const stranger = await netting(ann.token, eve.id);
    expect(stranger.statusCode).toBe(409);
    expect(stranger.json()).toEqual({ type: 'NothingToNet', message: expect.any(String) });

    expect((await netting(ann.token, bob.id)).statusCode).toBe(201);
    const settledBefore = await send(app, 'GET', `/groups/${flat}/settlements`, { token: ann.token });
    const again = await netting(ann.token, bob.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ type: 'NothingToNet', message: expect.any(String) });
    const settledAfter = await send(app, 'GET', `/groups/${flat}/settlements`, { token: ann.token });
    expect(settledAfter.json()).toEqual(settledBefore.json());
  });

  it('is refused with 401 when the caller is not signed in', async () => {
    const { bob } = await annAndBob();
    const response = await send(app, 'POST', '/nettings', { payload: { with: bob.id, currency: 'EUR' } });
    expect(response.statusCode).toBe(401);
  });

  it('nets only the groups in the currency asked: a group in another currency is left out', async () => {
    const { ann, bob } = await annAndBob();
    // In a dollar group Bob owes Ann 1000: it would change the netting if it counted, and it must not.
    const dollars = await groupWith(ann, bob, 'USD');
    await spend(ann, dollars, 200000, [ann.id, bob.id]);

    const response = await netting(ann.token, bob.id, 'EUR');
    expect(response.statusCode).toBe(201);
    expect(response.json<{ id: string }>().id).toEqual(expect.any(String));
    const netted = (
      await send(app, 'GET', `/nettings/${response.json<{ id: string }>().id}`, { token: ann.token })
    ).json<Netting>();
    expect(netted.amount).toBe(40000);
  });

  it('never refunds a netted settlement: the payee of one is refused', async () => {
    const { ann, bob, flat } = await annAndBob();
    const { id } = (await netting(ann.token, bob.id)).json<{ id: string }>();
    const { settlements } = (await send(app, 'GET', `/nettings/${id}`, { token: ann.token })).json<Netting>();
    const payment = (await send(app, 'GET', `/settlements/${settlements[0]}`, { token: ann.token })).json<{
      groupId: string;
    }>();
    expect(payment.groupId).toBe(flat);

    const refund = await send(app, 'POST', `/settlements/${settlements[0]}/refund`, { token: bob.token });
    expect(refund.statusCode).toBe(409);
    expect(refund.json()).toEqual({ type: 'NotRefundable', message: expect.any(String) });
  });

  it('counts a payment waiting at the provider as paid, and leaves it pending', async () => {
    const { ann, bob, flat } = await annAndBob();
    await setPayoutAccount(app, bob.token, 'acct-bob');
    const paid = await send(app, 'POST', `/groups/${flat}/settlements/provider`, {
      token: ann.token,
      payload: { to: bob.id, amount: 30000 },
    });
    expect(paid.statusCode).toBe(201);
    const pendingId = paid.json<{ id: string }>().id;

    // The 300 in the flat is waiting at the provider, so it is paid as far as the netting goes: only the trip's 200 is left.
    const response = await netting(ann.token, bob.id);
    expect(response.statusCode).toBe(201);
    const netted = (
      await send(app, 'GET', `/nettings/${response.json<{ id: string }>().id}`, { token: ann.token })
    ).json<Netting>();
    expect(netted.amount).toBe(20000);
    expect(netted.settlements).toHaveLength(2);

    const waiting = await send(app, 'GET', `/settlements/${pendingId}`, { token: ann.token });
    expect(waiting.json()).toEqual(expect.objectContaining({ status: 'pending', method: 'provider' }));
    // The balances count only what is paid, so the flat still shows the 300 Ann owes: the netting counts it, the balances do not.
    expect(await balancesOf(ann.token, flat)).toEqual([
      { memberId: ann.id, balance: -30000 },
      { memberId: bob.id, balance: 30000 },
    ]);
  });

  it('nets two nettings asked at once, through two servers: one is made, the other refused, and nothing pays more than is owed', async () => {
    const { ann, bob, trip } = await annAndBob();
    const second = await createApplication({ databaseUrl, providerUrl: provider.url, providerTimeoutMs: 300 });
    try {
      const [one, two] = await Promise.all([netting(ann.token, bob.id), netting(ann.token, bob.id, 'EUR', second)]);
      expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
      const refused = one.statusCode === 409 ? one : two;
      expect(refused.json()).toEqual({ type: 'NothingToNet', message: expect.any(String) });
    } finally {
      await second.stop();
    }

    // Only one netting is made: the trip's 200 is paid down to 100 by it, and nothing is paid twice.
    expect(await balancesOf(ann.token, trip)).toEqual([
      { memberId: ann.id, balance: -10000 },
      { memberId: bob.id, balance: 10000 },
    ]);
    const all = await send(app, 'GET', `/groups/${trip}/settlements`, { token: ann.token });
    expect(all.json<unknown[]>()).toHaveLength(1);
  });
});
