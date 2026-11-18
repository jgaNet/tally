import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };

interface Insight {
  month: string;
  currency: string;
  category: string;
  amount: number;
}

describe('spending insights', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusToken: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Makes a group in the currency, owned by the token's account, and answers its id. */
  async function createGroup(currency = 'EUR', token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', '/groups', { body: { name: 'The flat', currency }, token });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  /** Brings the account into the group by an invitation of its owner. */
  async function join(groupId: string, accountToken: string, ownerToken = adaToken): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Records an expense of the group, paid by the token's account, and answers its id. */
  async function record(groupId: string, fields: Record<string, unknown>, token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Shop', ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  /** The insights of the account, as the API answers them. */
  async function insightsOf(token = adaToken): Promise<Insight[]> {
    const answer = await call(app, 'GET', '/accounts/me/insights', { token });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ token: linusToken } = await accountOf(linus));
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('is empty for an account that is in no group', async () => {
    expect(await insightsOf()).toEqual([]);
  });

  it('answers what the account spent, by month, currency and category, as the request gives it', async () => {
    const flat = await createGroup('EUR');
    await join(flat, graceToken);
    const trip = await createGroup('CHF');
    await join(trip, graceToken);

    await record(flat, {
      amount: 8000,
      date: '2026-03-05',
      category: 'groceries',
      splitExactly: [
        { memberId: adaId, amount: 4000 },
        { memberId: graceId, amount: 4000 },
      ],
    });
    await record(flat, {
      amount: 7000,
      date: '2026-04-05',
      category: 'groceries',
      splitExactly: [
        { memberId: adaId, amount: 3500 },
        { memberId: graceId, amount: 3500 },
      ],
    });
    await record(trip, {
      amount: 50000,
      date: '2026-04-12',
      category: 'travel',
      splitExactly: [
        { memberId: adaId, amount: 25000 },
        { memberId: graceId, amount: 25000 },
      ],
    });

    expect(await insightsOf()).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 3500 },
    ]);
  });

  it('counts the shares of the account, not what it paid', async () => {
    const flat = await createGroup('EUR');
    await join(flat, graceToken);
    // Ada pays all of it, and her share of it is nothing.
    await record(flat, {
      amount: 9000,
      date: '2026-02-01',
      splitExactly: [
        { memberId: graceId, amount: 9000 },
        { memberId: adaId, amount: 0 },
      ],
    });
    // Grace pays it, and Ada's share of it is 3000.
    await record(
      flat,
      {
        amount: 9000,
        date: '2026-02-01',
        splitExactly: [
          { memberId: adaId, amount: 3000 },
          { memberId: graceId, amount: 6000 },
        ],
      },
      graceToken,
    );

    expect(await insightsOf()).toEqual([{ month: '2026-02', currency: 'EUR', category: 'other', amount: 3000 }]);
  });

  it('sums the shares of one month, currency and category, and gives an expense without a category other', async () => {
    const flat = await createGroup('EUR');
    await record(flat, { amount: 1000, date: '2026-05-02', splitBetween: [adaId] });
    await record(flat, { amount: 2500, date: '2026-05-20', splitBetween: [adaId], category: 'other' });

    expect(await insightsOf()).toEqual([{ month: '2026-05', currency: 'EUR', category: 'other', amount: 3500 }]);
  });

  it('counts an expense in another currency in the currency of its group, at the rate it was given', async () => {
    const flat = await createGroup('EUR');
    await record(flat, {
      original: { currency: 'CHF', amount: 1000, rate: '0.9' },
      date: '2026-03-14',
      splitBetween: [adaId],
      category: 'food',
    });

    expect(await insightsOf()).toEqual([{ month: '2026-03', currency: 'EUR', category: 'food', amount: 900 }]);
  });

  it('does not count a deleted expense', async () => {
    const flat = await createGroup('EUR');
    await record(flat, { amount: 500, date: '2026-03-01', splitBetween: [adaId] });
    const deleted = await record(flat, { amount: 1000, date: '2026-03-02', splitBetween: [adaId] });
    expect((await call(app, 'DELETE', `/expenses/${deleted}`, { token: adaToken })).status).toBe(204);

    expect(await insightsOf()).toEqual([{ month: '2026-03', currency: 'EUR', category: 'other', amount: 500 }]);
  });

  it('counts nothing for a group the account has left, and keeps what it spent in the groups it is in', async () => {
    const owned = await createGroup('EUR', graceToken);
    await join(owned, adaToken, graceToken);
    await record(owned, {
      amount: 2000,
      date: '2026-06-01',
      category: 'rent',
      splitExactly: [{ memberId: adaId, amount: 2000 }],
    });
    const mine = await createGroup('USD');
    await record(mine, { amount: 700, date: '2026-06-03', category: 'leisure', splitBetween: [adaId] });
    expect(await insightsOf()).toHaveLength(2);

    // Ada's balance in the group they joined is 0, so she may leave it.
    expect((await call(app, 'POST', `/groups/${owned}/leave`, { token: adaToken })).status).toBe(204);

    expect(await insightsOf()).toEqual([{ month: '2026-06', currency: 'USD', category: 'leisure', amount: 700 }]);
  });

  it('counts nothing for a share of nothing', async () => {
    const flat = await createGroup('EUR');
    await join(flat, graceToken);
    await record(flat, {
      amount: 500,
      date: '2026-03-09',
      splitExactly: [
        { memberId: adaId, amount: 0 },
        { memberId: graceId, amount: 500 },
      ],
    });

    expect(await insightsOf()).toEqual([]);
    expect(await insightsOf(graceToken)).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'other', amount: 500 },
    ]);
  });

  it('counts the expenses of a merged group once, in the group kept', async () => {
    const flat = await createGroup('EUR');
    const rent = await createGroup('EUR');
    await record(flat, { amount: 4000, date: '2026-03-10', category: 'groceries', splitBetween: [adaId] });
    await record(rent, { amount: 6000, date: '2026-03-01', category: 'rent', splitBetween: [adaId] });
    const before = await insightsOf();
    expect(before).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-03', currency: 'EUR', category: 'rent', amount: 6000 },
    ]);

    expect((await call(app, 'POST', `/groups/${flat}/merge`, { body: { from: rent }, token: adaToken })).status).toBe(
      204,
    );

    expect(await insightsOf()).toEqual(before);
  });

  it('still counts an archived group, which is read only', async () => {
    const flat = await createGroup('EUR');
    await record(flat, { amount: 1000, date: '2026-01-15', splitBetween: [adaId] });
    expect((await call(app, 'POST', `/groups/${flat}/archive`, { token: adaToken })).status).toBe(204);

    expect(await insightsOf()).toEqual([{ month: '2026-01', currency: 'EUR', category: 'other', amount: 1000 }]);
  });

  it('places an expense in the month of its day in UTC', async () => {
    const flat = await createGroup('EUR');
    await record(flat, { amount: 100, date: '2026-03-31', splitBetween: [adaId] });
    await record(flat, { amount: 200, date: '2026-04-01', splitBetween: [adaId] });

    expect(await insightsOf()).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'other', amount: 100 },
      { month: '2026-04', currency: 'EUR', category: 'other', amount: 200 },
    ]);
  });

  it('lists the earliest month first, the currencies alphabetically, and the categories in their order', async () => {
    const eur = await createGroup('EUR');
    const usd = await createGroup('USD');
    await record(eur, { amount: 50, date: '2026-05-08', category: 'other', splitBetween: [adaId] });
    await record(eur, { amount: 100, date: '2026-05-09', category: 'transport', splitBetween: [adaId] });
    await record(eur, { amount: 200, date: '2026-01-07', category: 'leisure', splitBetween: [adaId] });
    await record(eur, { amount: 300, date: '2026-01-08', category: 'groceries', splitBetween: [adaId] });
    await record(usd, { amount: 700, date: '2026-01-09', category: 'rent', splitBetween: [adaId] });

    expect(await insightsOf()).toEqual([
      { month: '2026-01', currency: 'EUR', category: 'groceries', amount: 300 },
      { month: '2026-01', currency: 'EUR', category: 'leisure', amount: 200 },
      { month: '2026-01', currency: 'USD', category: 'rent', amount: 700 },
      { month: '2026-05', currency: 'EUR', category: 'transport', amount: 100 },
      { month: '2026-05', currency: 'EUR', category: 'other', amount: 50 },
    ]);
  });

  it('gives each person their own shares, and nobody else their own', async () => {
    const flat = await createGroup('EUR');
    await join(flat, graceToken);
    await record(
      flat,
      {
        amount: 1000,
        date: '2026-02-10',
        splitExactly: [{ memberId: graceId, amount: 1000 }],
      },
      graceToken,
    );

    expect(await insightsOf()).toEqual([]);
    expect(await insightsOf(graceToken)).toEqual([
      { month: '2026-02', currency: 'EUR', category: 'other', amount: 1000 },
    ]);
    expect(await insightsOf(linusToken)).toEqual([]);
  });

  it('refuses a read without a signed-in account with 401', async () => {
    expect((await call(app, 'GET', '/accounts/me/insights')).status).toBe(401);
    expect((await call(app, 'GET', '/accounts/me/insights', { token: 'made-up-token' })).status).toBe(401);
  });
});
