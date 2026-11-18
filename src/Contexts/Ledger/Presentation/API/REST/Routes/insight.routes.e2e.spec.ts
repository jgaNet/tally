import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Spending insights, end to end (request 37): the application booted in this process, spoken to over HTTP, every answer held to
 * api/37-spending-insights.yaml by the client. The day is the server's, as its own Date header says.
 */
const PASSWORD = 'correct horse';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

let counter = 0;
const uniqueEmail = (name: string) => `${name}.${++counter}.${Math.random().toString(36).slice(2)}@example.com`;

/** The server's today, from its own Date header: the test reads no clock of its own. */
async function todayOf(token: string): Promise<string> {
  const answer = await http.get('/v1/accounts/me', { token });
  return new Date(answer.headers.get('date') ?? '').toISOString().slice(0, 10);
}

/** A EUR group of two: the owner, and a member who joined it. */
async function groupOfTwo(): Promise<{
  owner: { token: string; id: string };
  other: { token: string; id: string };
  groupId: string;
}> {
  const owner = await accountOf(uniqueEmail('owner'), 'Ana');
  const other = await accountOf(uniqueEmail('other'), 'Ben');
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: other.token,
  });
  return { owner, other, groupId };
}

const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const insightsOf = async (token: string) => (await http.get('/v1/accounts/me/insights', { token })).body;

describe('Ledger: spending insights (request 37)', () => {
  it('reads each person their own shares by month, currency and category, in the order the request gives', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const date = await todayOf(owner.token);
    const month = date.slice(0, 7);
    const trip = await http.request('POST', '/v1/groups', {
      body: { name: 'The trip', currency: 'CHF' },
      token: owner.token,
    });
    const tripId = (trip.body as { id: string }).id;
    const split = { splitBetween: [owner.id, other.id] };

    expect(
      await record(groupId, owner.token, { description: 'Shop', date, amount: 8_000, category: 'groceries', ...split }),
    ).toMatchObject({ status: 201 });
    expect(
      await record(groupId, owner.token, { description: 'Flat', date, amount: 90_000, category: 'rent', ...split }),
    ).toMatchObject({ status: 201 });
    expect(
      await record(tripId, owner.token, {
        description: 'Train',
        date,
        amount: 25_000,
        category: 'travel',
        splitBetween: [owner.id],
      }),
    ).toMatchObject({ status: 201 });

    expect(await insightsOf(owner.token)).toEqual([
      { month, currency: 'CHF', category: 'travel', amount: 25_000 },
      { month, currency: 'EUR', category: 'groceries', amount: 4_000 },
      { month, currency: 'EUR', category: 'rent', amount: 45_000 },
    ]);
    expect(await insightsOf(other.token)).toEqual([
      { month, currency: 'EUR', category: 'groceries', amount: 4_000 },
      { month, currency: 'EUR', category: 'rent', amount: 45_000 },
    ]);
  });

  it('counts nothing for a deleted expense, nor for a group the person has left', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const date = await todayOf(other.token);
    const taxi = await record(groupId, other.token, {
      description: 'Taxi',
      date,
      amount: 10_000,
      category: 'transport',
      splitBetween: [other.id],
    });
    const oops = await record(groupId, owner.token, {
      description: 'Oops',
      date,
      amount: 1_000,
      category: 'food',
      splitBetween: [owner.id],
    });
    const deleted = await http.request('DELETE', `/v1/expenses/${(oops.body as { id: string }).id}`, {
      token: owner.token,
    });
    expect(deleted.status).toBeLessThan(300);
    expect(taxi.status).toBe(201);

    expect(await insightsOf(owner.token)).toEqual([]);
    expect(await insightsOf(other.token)).toEqual([
      { month: date.slice(0, 7), currency: 'EUR', category: 'transport', amount: 10_000 },
    ]);

    const left = await http.request('POST', `/v1/groups/${groupId}/leave`, { token: other.token });
    expect(left.status).toBeLessThan(300);
    expect(await insightsOf(other.token)).toEqual([]);
  });

  it('Groups → Ledger: a group made in Groups is the one Ledger counts the spending in, by the id Groups answered', async () => {
    const ana = await accountOf(uniqueEmail('ana.link'), 'Ana');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'The cottage', currency: 'GBP' },
      token: ana.token,
    });
    const groupId = (created.body as { id: string }).id;
    const date = await todayOf(ana.token);

    const recorded = await record(groupId, ana.token, {
      description: 'Cottage',
      date,
      amount: 6_000,
      category: 'leisure',
      splitBetween: [ana.id],
    });
    expect(recorded.status).toBe(201);

    const expenses = (await http.get(`/v1/groups/${groupId}/expenses`, { token: ana.token })).body as {
      description: string;
      groupId: string;
    }[];
    expect(expenses).toEqual([expect.objectContaining({ description: 'Cottage', groupId })]);
    expect(await insightsOf(ana.token)).toContainEqual({
      month: date.slice(0, 7),
      currency: 'GBP',
      category: 'leisure',
      amount: 6_000,
    });
  });

  it('answers a caller who is not signed in with 401', async () => {
    expect(await http.get('/v1/accounts/me/insights')).toMatchObject({ status: 401 });
  });
});
