import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('insights');

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';

type Line = { month: string; currency: string; category: string; amount: number };

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

async function groupWith(
  owner: { token: string },
  currency: string,
  joiners: Array<{ token: string }>,
): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: `Group ${currency}`, currency },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readInsights = (token?: string) => http.request('GET', `${api}/accounts/me/insights`, { token });

describe('spending insights (request 37)', () => {
  it('answers 401 to a caller who is not signed in', async () => {
    const response = await readInsights();
    expect(response.status).toBe(401);
  });

  it('lists what each person spent, by month, currency and category, across their groups, in the order asked', async () => {
    const ada = await signedIn('insights-ada@example.com', 'Ada');
    const ben = await signedIn('insights-ben@example.com', 'Ben');
    const flat = await groupWith(ada, 'EUR', [ben]);
    const trip = await groupWith(ben, 'CHF', [ada]);

    await record(ada.token, flat, {
      description: 'Flat',
      amount: 400,
      date: '2026-03-01',
      category: 'rent',
      splitBetween: [ada.id, ben.id],
    });
    await record(ben.token, flat, {
      description: 'Market',
      amount: 150,
      date: '2026-03-05',
      category: 'groceries',
      splitBetween: [ada.id, ben.id],
    });
    await record(ben.token, trip, {
      description: 'Train',
      amount: 250,
      date: '2026-04-02',
      category: 'travel',
      splitBetween: [ada.id, ben.id],
    });

    const adaLines = (await readInsights(ada.token)).body as Line[];
    expect(adaLines).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 75 },
      { month: '2026-03', currency: 'EUR', category: 'rent', amount: 200 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 125 },
    ]);

    const benLines = (await readInsights(ben.token)).body as Line[];
    expect(benLines).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 75 },
      { month: '2026-03', currency: 'EUR', category: 'rent', amount: 200 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 125 },
    ]);
  });

  it('counts a deleted expense for nothing', async () => {
    const ada = await signedIn('insights-deleter@example.com', 'Dee');
    const ben = await signedIn('insights-deleted@example.com', 'Dan');
    const flat = await groupWith(ada, 'EUR', [ben]);
    const rent = await record(ada.token, flat, {
      description: 'Flat',
      amount: 400,
      date: '2026-05-01',
      category: 'rent',
      splitBetween: [ada.id, ben.id],
    });
    expect((await readInsights(ada.token)).body).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'rent', amount: 200 },
    ]);

    await http.request('DELETE', `${api}/expenses/${(rent.body as { id: string }).id}`, { token: ada.token });
    expect((await readInsights(ada.token)).body).toEqual([]);
  });

  it('answers an empty list to a person who is in no group', async () => {
    const lone = await signedIn('insights-lone@example.com', 'Lone');
    const response = await readInsights(lone.token);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe('Groups → Ledger', () => {
  it('reads the groups the caller is in, and their currencies, from Groups by the ids its group answers', async () => {
    const ann = await signedIn('insights-rel-ann@example.com', 'Ann');
    const bob = await signedIn('insights-rel-bob@example.com', 'Bob');
    // Groups answers the group's id; Ledger reads the same group by that id, its members and its currency.
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Trip', currency: 'CHF' },
      token: ann.token,
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const recorded = await record(bob.token, groupId, {
      description: 'Hotel',
      amount: 180,
      date: '2026-06-10',
      category: 'travel',
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBeLessThan(300);

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token }))
      .body as Array<{
      memberId: string;
    }>;
    expect(balances.map(each => each.memberId)).toEqual([ann.id, bob.id]);
    expect((await readInsights(ann.token)).body).toEqual([
      { month: '2026-06', currency: 'CHF', category: 'travel', amount: 90 },
    ]);
  });
});
