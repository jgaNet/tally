import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The three relationships request 12 carries, each over HTTP: Groups → Settlements (a settlement in a group Groups made), Ledger →
 * Settlements (the suggestions read the expenses' balances), and Settlements → Ledger (a settlement recorded is counted by Ledger's
 * balances). Each keeps the id the request that made the thing answered, and finds the thing again by that id.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_URL = await freshDatabaseUrl();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

async function joined(groupId: string, owner: string, person: { token: string }) {
  const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner })).body as {
    id: string;
  };
  await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
}

describe('Groups → Settlements', () => {
  it('records a settlement in a group Groups made, by the id its request answered, from a member who joined later, and reads it by that id', async () => {
    const ada = await signedInPerson('Ada');
    const linus = await signedInPerson('Linus');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };
    await joined(groupId, ada.token, linus);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, linus.id] },
      token: ada.token,
    });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: linus.id, amount: 30 },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const read = await http.request('GET', `${api}/settlements/${(recorded.body as { id: string }).id}`, {
      token: linus.token,
    });
    expect((read.body as { groupId: string }).groupId).toBe(groupId);
  });
});

describe('Ledger → Settlements', () => {
  it('suggests the transfer of an expense recorded in Ledger, by the id its request answered, and records that transfer as a settlement', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Trip', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    await joined(groupId, ada.token, grace);
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Train', amount: 80, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const expenseId = (expense.body as { id: string }).id;
    expect((await http.request('GET', `${api}/expenses/${expenseId}`, { token: grace.token })).status).toBe(200);

    const suggested = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, {
      token: grace.token,
    });
    expect(suggested.body).toEqual([{ from: grace.id, to: ada.id, amount: 40 }]);

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 40 },
      token: ada.token,
    });
    const settlementId = (recorded.body as { id: string }).id;
    expect((await http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token })).status).toBe(200);
    expect(
      await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: grace.token }),
    ).toMatchObject({ body: [] });
  });
});

describe('Settlements → Ledger', () => {
  it('counts a settlement, by the id its request answered, in the balances Ledger reads, and a member who leaves with a zero balance after it', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Club', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    await joined(groupId, ada.token, grace);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Tickets', amount: 20, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 10 },
      token: ada.token,
    });
    const settlementId = (recorded.body as { id: string }).id;
    expect((await http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token })).status).toBe(200);

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: grace.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances).toEqual([
      { memberId: ada.id, balance: 0 },
      { memberId: grace.id, balance: 0 },
    ]);

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token });
    expect(left.status).toBe(204);
  });
});
