import { createApplication, type Application } from './app';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const START = Date.parse('2026-11-10T09:00:00.000Z');

interface Member {
  id: string;
  token: string;
}

/** One line of the insights, as the API answers it. */
interface Insight {
  month: string;
  currency: string;
  category: string;
  amount: number;
}

describe('spending insights', () => {
  let directory: TestDirectory;
  let app: Application;

  async function startAt(): Promise<Application> {
    await ensureDatabase(directory.databaseUrl);
    const started = await createApplication({
      databaseUrl: directory.databaseUrl,
      clock: () => new Date(START),
    });
    await started.start(0);
    return started;
  }

  beforeEach(async () => {
    directory = testDirectory();
    app = await startAt();
  });

  afterEach(async () => {
    await app.stop();
    await directory.remove();
  });

  /** A group in `currency` owned by `owner`, which each of `joined` joined. */
  async function groupWith(owner: Member, joined: Member[], currency: string): Promise<string> {
    const created = await send(app, 'POST', '/groups', { token: owner.token, body: { name: 'Group', currency } });
    if (created.status !== 201) throw new Error(`group answered ${created.status}`);
    const groupId = (created.body as { id: string }).id;
    for (const member of joined) {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: owner.token });
      const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: member.token,
      });
      if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    }
    return groupId;
  }

  /** An expense of `amount` on `date`, split equally between `members`, in `category` when given. */
  async function recordEqual(
    payer: Member,
    groupId: string,
    members: Member[],
    amount: number,
    date: string,
    category?: string,
  ): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: payer.token,
      body: {
        description: 'Shop',
        amount,
        date,
        splitBetween: members.map(member => member.id),
        ...(category === undefined ? {} : { category }),
      },
    });
    if (reply.status !== 201) throw new Error(`expense answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The insights the account of `token` reads. */
  async function insightsOf(token: string): Promise<Insight[]> {
    const reply = await send(app, 'GET', '/accounts/me/insights', { token });
    expect(reply.status).toBe(200);
    return reply.body as Insight[];
  }

  it('answers an empty list to an account with no group, and refuses a caller not signed in', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    expect(await insightsOf(ann.token)).toEqual([]);
    expect(await send(app, 'GET', '/accounts/me/insights')).toMatchObject({ status: 401 });
    expect(await send(app, 'GET', '/accounts/me/insights', { token: 'not-a-real-token' })).toMatchObject({
      status: 401,
    });
  });

  it('reads the lines of the example: each month, currency and category where the caller spent, in order', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const flat = await groupWith(ann, [ben], 'EUR');
    const trip = await groupWith(ben, [ann], 'CHF');
    // Ann's share of the flat's groceries: 4000 in March and 3500 in April, in euros.
    await recordEqual(ann, flat, [ann, ben], 8000, '2026-03-05', 'groceries');
    await recordEqual(ben, flat, [ann, ben], 7000, '2026-04-09', 'groceries');
    // Ann's share of a trip's travel: 25000 in April, in Swiss francs.
    await recordEqual(ben, trip, [ann, ben], 50000, '2026-04-20', 'travel');

    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 3500 },
    ]);
  });

  it('counts only the caller’s shares, not what they paid beyond their share, nor what others paid for them', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const group = await groupWith(ann, [ben, cy], 'EUR');
    // Ann pays 900 for three: her share is 300, the rest is owed to her.
    await recordEqual(ann, group, [ann, ben, cy], 900, '2026-05-01', 'food');
    // Ben pays 600 for himself and Cy only: Ann has no share in it.
    const gift = await send(app, 'POST', `/groups/${group}/expenses`, {
      token: ben.token,
      body: {
        description: 'Gift',
        amount: 600,
        date: '2026-05-02',
        splitBetween: [ben.id, cy.id],
        category: 'leisure',
      },
    });
    expect(gift.status).toBe(201);
    // Ben pays for Ann: her share is 500.
    await send(app, 'POST', `/groups/${group}/expenses`, {
      token: ben.token,
      body: {
        description: 'Taxi',
        amount: 1000,
        date: '2026-05-03',
        splitExactly: [
          { memberId: ann.id, amount: 500 },
          { memberId: ben.id, amount: 500 },
        ],
        category: 'transport',
      },
    });
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'transport', amount: 500 },
      { month: '2026-05', currency: 'EUR', category: 'food', amount: 300 },
    ]);
    expect(await insightsOf(cy.token)).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'food', amount: 300 },
      { month: '2026-05', currency: 'EUR', category: 'leisure', amount: 300 },
    ]);
  });

  it('orders the months earliest first, the currencies alphabetically in a month, and the categories as the budgets list them', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const eur = await groupWith(ann, [ben], 'EUR');
    const usd = await groupWith(ann, [ben], 'USD');
    const gbp = await groupWith(ann, [ben], 'GBP');
    await recordEqual(ann, eur, [ann, ben], 200, '2026-06-01', 'other');
    await recordEqual(ann, eur, [ann, ben], 200, '2026-06-01', 'travel');
    await recordEqual(ann, eur, [ann, ben], 200, '2026-06-01', 'groceries');
    await recordEqual(ann, usd, [ann, ben], 200, '2026-06-02', 'groceries');
    await recordEqual(ann, gbp, [ann, ben], 200, '2026-06-03', 'rent');
    await recordEqual(ann, eur, [ann, ben], 200, '2026-01-31', 'leisure');

    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-01', currency: 'EUR', category: 'leisure', amount: 100 },
      { month: '2026-06', currency: 'EUR', category: 'groceries', amount: 100 },
      { month: '2026-06', currency: 'EUR', category: 'travel', amount: 100 },
      { month: '2026-06', currency: 'EUR', category: 'other', amount: 100 },
      { month: '2026-06', currency: 'GBP', category: 'rent', amount: 100 },
      { month: '2026-06', currency: 'USD', category: 'groceries', amount: 100 },
    ]);
  });

  it('places an expense by its day, in the month of that day, so the last day of a month is not the next', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const group = await groupWith(ann, [ben], 'EUR');
    await recordEqual(ann, group, [ann, ben], 400, '2026-03-31', 'rent');
    await recordEqual(ann, group, [ann, ben], 600, '2026-04-01', 'rent');
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'rent', amount: 200 },
      { month: '2026-04', currency: 'EUR', category: 'rent', amount: 300 },
    ]);
  });

  it('counts an expense in its group’s currency, whatever it was paid in', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const group = await groupWith(ann, [ben], 'EUR');
    const reply = await send(app, 'POST', `/groups/${group}/expenses`, {
      token: ann.token,
      body: {
        description: 'Hotel',
        date: '2026-07-07',
        splitBetween: [ann.id, ben.id],
        category: 'travel',
        original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      },
    });
    expect(reply.status).toBe(201);
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-07', currency: 'EUR', category: 'travel', amount: 656 },
    ]);
  });

  it('counts nothing deleted, and an edited expense by what it is now', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const group = await groupWith(ann, [ben], 'EUR');
    const kept = await recordEqual(ann, group, [ann, ben], 1000, '2026-08-01', 'groceries');
    const gone = await recordEqual(ann, group, [ann, ben], 2000, '2026-08-02', 'groceries');
    expect((await send(app, 'DELETE', `/expenses/${gone}`, { token: ann.token })).status).toBe(204);
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-08', currency: 'EUR', category: 'groceries', amount: 500 },
    ]);

    const edited = await send(app, 'PUT', `/expenses/${kept}`, {
      token: ann.token,
      body: {
        description: 'Shop',
        amount: 1000,
        date: '2026-09-01',
        splitBetween: [ann.id, ben.id],
        category: 'rent',
        version: 1,
      },
    });
    expect(edited.status).toBe(200);
    expect(await insightsOf(ann.token)).toEqual([{ month: '2026-09', currency: 'EUR', category: 'rent', amount: 500 }]);
  });

  it('counts the shares of an exact split and of a split by shares, as they were given', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const group = await groupWith(ann, [ben], 'EUR');
    await send(app, 'POST', `/groups/${group}/expenses`, {
      token: ben.token,
      body: {
        description: 'Desk',
        amount: 1000,
        date: '2026-10-01',
        splitExactly: [
          { memberId: ann.id, amount: 250 },
          { memberId: ben.id, amount: 750 },
        ],
        category: 'utilities',
      },
    });
    await send(app, 'POST', `/groups/${group}/expenses`, {
      token: ben.token,
      body: {
        description: 'Lamp',
        amount: 900,
        date: '2026-10-02',
        splitByShares: [
          { memberId: ann.id, shares: 1 },
          { memberId: ben.id, shares: 2 },
        ],
        category: 'utilities',
      },
    });
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-10', currency: 'EUR', category: 'utilities', amount: 550 },
    ]);
  });

  it('adds up the caller’s shares across every group they are a member of, and only those', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const flat = await groupWith(ann, [ben], 'EUR');
    const other = await groupWith(cy, [ann], 'EUR');
    await recordEqual(ben, flat, [ann, ben], 1000, '2026-11-03', 'groceries');
    await recordEqual(cy, other, [ann, cy], 1000, '2026-11-04', 'groceries');
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-11', currency: 'EUR', category: 'groceries', amount: 1000 },
    ]);
    // Cy's insights count Cy's share of the other group only, not Ann's share in it.
    expect(await insightsOf(cy.token)).toEqual([
      { month: '2026-11', currency: 'EUR', category: 'groceries', amount: 500 },
    ]);
  });

  it('counts nothing of a group the caller has left, and counts it again once they rejoin', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const group = await groupWith(ben, [ann], 'EUR');
    await recordEqual(ben, group, [ann, ben], 800, '2026-11-01', 'leisure');
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-11', currency: 'EUR', category: 'leisure', amount: 400 },
    ]);

    expect((await send(app, 'POST', `/groups/${group}/leave`, { token: ann.token })).status).toBe(204);
    expect(await insightsOf(ann.token)).toEqual([]);
    // Ben still reads his own share, which the group keeps.
    expect(await insightsOf(ben.token)).toEqual([
      { month: '2026-11', currency: 'EUR', category: 'leisure', amount: 400 },
    ]);

    const invitation = await send(app, 'POST', `/groups/${group}/invitations`, { token: ben.token });
    expect(
      (await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, { token: ann.token }))
        .status,
    ).toBe(204);
    expect(await insightsOf(ann.token)).toEqual([
      { month: '2026-11', currency: 'EUR', category: 'leisure', amount: 400 },
    ]);
  });

  it('reads each person their own: nobody reads another’s shares, and reading changes nothing', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.com', name: 'Ben' });
    const group = await groupWith(ann, [ben], 'EUR');
    await recordEqual(ann, group, [ann, ben], 600, '2026-11-05', 'food');
    const first = await insightsOf(ben.token);
    expect(first).toEqual([{ month: '2026-11', currency: 'EUR', category: 'food', amount: 300 }]);
    expect(await insightsOf(ben.token)).toEqual(first);
    expect(await insightsOf(ann.token)).toEqual([{ month: '2026-11', currency: 'EUR', category: 'food', amount: 300 }]);
    const stranger = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    expect(await insightsOf(stranger.token)).toEqual([]);
  });
});
