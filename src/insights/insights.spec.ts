import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

describe('spending insights', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function createGroup(token: string, name: string, currency: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name, currency } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function insightsOf(token: string) {
    const response = await send(app, 'GET', '/accounts/me/insights', { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ month: string; currency: string; category: string; amount: number }[]>();
  }

  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const flat = await createGroup(ada.token, 'Flat', 'EUR');
    const trip = await createGroup(ada.token, 'Trip', 'CHF');
    await joinThroughInvitation(app, ada.token, grace.token, flat);
    await joinThroughInvitation(app, ada.token, grace.token, trip);
    return { ada, grace, flat, trip };
  }

  it('gives what one spent across the groups, by month, currency and category, the earliest first', async () => {
    const { ada, grace, flat, trip } = await setup();
    await record(ada.token, flat, {
      description: 'Shop',
      amount: 8000,
      date: '2026-03-10',
      category: 'groceries',
      splitExactly: [
        { memberId: ada.id, amount: 4000 },
        { memberId: grace.id, amount: 4000 },
      ],
    });
    await record(ada.token, flat, {
      description: 'Shop',
      amount: 7000,
      date: '2026-04-02',
      category: 'groceries',
      splitExactly: [
        { memberId: ada.id, amount: 3500 },
        { memberId: grace.id, amount: 3500 },
      ],
    });
    await record(ada.token, trip, {
      description: 'Train',
      amount: 30000,
      date: '2026-04-20',
      category: 'travel',
      splitExactly: [
        { memberId: ada.id, amount: 25000 },
        { memberId: grace.id, amount: 5000 },
      ],
    });

    expect(await insightsOf(ada.token)).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 3500 },
    ]);
  });

  it('sums the shares of one month, currency and category, and orders the categories as they are listed', async () => {
    const { ada, grace, flat } = await setup();
    await record(ada.token, flat, {
      description: 'Shop',
      amount: 1000,
      date: '2026-03-01',
      category: 'groceries',
      splitExactly: [
        { memberId: ada.id, amount: 600 },
        { memberId: grace.id, amount: 400 },
      ],
    });
    await record(ada.token, flat, {
      description: 'Shop again',
      amount: 2000,
      date: '2026-03-31',
      category: 'groceries',
      splitExactly: [
        { memberId: ada.id, amount: 1500 },
        { memberId: grace.id, amount: 500 },
      ],
    });
    await record(ada.token, flat, {
      description: 'Rent',
      amount: 5000,
      date: '2026-03-05',
      category: 'rent',
      splitExactly: [
        { memberId: ada.id, amount: 2500 },
        { memberId: grace.id, amount: 2500 },
      ],
    });
    await record(ada.token, flat, {
      description: 'Other',
      amount: 300,
      date: '2026-03-06',
      splitExactly: [
        { memberId: ada.id, amount: 300 },
        { memberId: grace.id, amount: 0 },
      ],
    });

    expect(await insightsOf(ada.token)).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 2100 },
      { month: '2026-03', currency: 'EUR', category: 'rent', amount: 2500 },
      { month: '2026-03', currency: 'EUR', category: 'other', amount: 300 },
    ]);
  });

  it('counts only her own shares: what she paid for others, and what others paid for her, is not spending', async () => {
    const { ada, grace, flat } = await setup();
    // Grace pays for both of them: Ada's share is 3000.
    await record(grace.token, flat, {
      description: 'Dinner',
      amount: 9000,
      date: '2026-05-01',
      splitExactly: [
        { memberId: ada.id, amount: 3000 },
        { memberId: grace.id, amount: 6000 },
      ],
    });
    // Ada pays for Grace alone, and is in the split for nothing: none of it is hers.
    await record(ada.token, flat, {
      description: 'Gift',
      amount: 1000,
      date: '2026-05-02',
      category: 'leisure',
      splitExactly: [
        { memberId: ada.id, amount: 0 },
        { memberId: grace.id, amount: 1000 },
      ],
    });

    expect(await insightsOf(ada.token)).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'other', amount: 3000 },
    ]);
    expect(await insightsOf(grace.token)).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'leisure', amount: 1000 },
      { month: '2026-05', currency: 'EUR', category: 'other', amount: 6000 },
    ]);
  });

  it('counts for nothing an expense that is deleted', async () => {
    const { ada, grace, flat } = await setup();
    const id = await record(ada.token, flat, {
      description: 'Shop',
      amount: 2000,
      date: '2026-06-03',
      category: 'groceries',
      splitBetween: [ada.id, grace.id],
    });
    expect(await insightsOf(ada.token)).toEqual([
      { month: '2026-06', currency: 'EUR', category: 'groceries', amount: 1000 },
    ]);

    const deleted = await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token });
    expect(deleted.statusCode).toBe(204);
    expect(await insightsOf(ada.token)).toEqual([]);
  });

  it('counts for nothing the groups one has left', async () => {
    const { grace, flat } = await setup();
    // Grace paid for her own share alone, so her balance is 0 and she may leave.
    await record(grace.token, flat, {
      description: 'Groceries',
      amount: 1000,
      date: '2026-07-07',
      category: 'groceries',
      splitBetween: [grace.id],
    });
    expect(await insightsOf(grace.token)).toEqual([
      { month: '2026-07', currency: 'EUR', category: 'groceries', amount: 1000 },
    ]);

    const left = await send(app, 'POST', `/groups/${flat}/leave`, { token: grace.token });
    expect(left.statusCode).toBe(204);
    expect(await insightsOf(grace.token)).toEqual([]);
  });

  it('counts an expense in the currency of its group, whatever it was paid in', async () => {
    const { ada, grace, flat } = await setup();
    await record(ada.token, flat, {
      description: 'Dinner in Zurich',
      original: { currency: 'CHF', amount: 1000, rate: '1' },
      date: '2026-08-08',
      category: 'food',
      splitBetween: [ada.id, grace.id],
    });

    expect(await insightsOf(ada.token)).toEqual([{ month: '2026-08', currency: 'EUR', category: 'food', amount: 500 }]);
  });

  it('still counts the expenses of a group that is archived', async () => {
    const { ada, grace, flat } = await setup();
    // Each pays for both, so every balance is 0 and the group may be archived.
    for (const payer of [ada, grace]) {
      await record(payer.token, flat, {
        description: 'Shop',
        amount: 4000,
        date: '2026-09-09',
        category: 'groceries',
        splitExactly: [
          { memberId: ada.id, amount: 2000 },
          { memberId: grace.id, amount: 2000 },
        ],
      });
    }
    const archived = await send(app, 'POST', `/groups/${flat}/archive`, { token: ada.token });
    expect(archived.statusCode).toBe(204);

    expect(await insightsOf(ada.token)).toEqual([
      { month: '2026-09', currency: 'EUR', category: 'groceries', amount: 4000 },
    ]);
  });

  it('answers nothing when nothing was spent, and refuses a request that is not signed in', async () => {
    const { ada } = await setup();
    expect(await insightsOf(ada.token)).toEqual([]);

    const anonymous = await send(app, 'GET', '/accounts/me/insights');
    expect(anonymous.statusCode).toBe(401);
  });
});
