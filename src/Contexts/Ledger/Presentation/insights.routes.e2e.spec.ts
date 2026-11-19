import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A person's spending across their groups, over HTTP (request 37): the sums of their shares by month, currency and category, the
 * earliest month first, then the currencies alphabetically, then the categories in the order of request 24; deleted expenses and
 * groups the person has left count for nothing; each person reads their own, and a caller who is not signed in is answered 401.
 * Groups and expenses are made through their own routes; the answers are held to the API `api/` gives, through `apiClient()`.
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
/** A signed-in person, with a fresh email, and their token. */
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

/** A group in `currency`, owned by `owner`, which each of `others` has joined through an invitation, in that order. */
async function groupWith(owner: { token: string }, others: { token: string }[], currency = 'EUR'): Promise<string> {
  const { id } = (await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency }, token: owner.token }))
    .body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const idOf = (answer: { body: unknown }) => (answer.body as { id: string }).id;
const insightsOf = (token?: string) => http.request('GET', `${api}/accounts/me/insights`, { token });

describe('a person’s spending across their groups', () => {
  it('sums their shares by month, currency and category, in the order the API states', async () => {
    const ann = await signedInPerson('Ann');
    const grace = await signedInPerson('Grace');
    const flat = await groupWith(ann, [grace]);
    const trip = await groupWith(grace, [ann], 'CHF');

    await record(
      flat,
      {
        description: 'Shop',
        amount: 8000,
        date: '2026-03-10',
        category: 'groceries',
        splitBetween: [ann.id, grace.id],
      },
      ann.token,
    );
    await record(
      flat,
      {
        description: 'Shop',
        amount: 7000,
        date: '2026-04-02',
        category: 'groceries',
        splitBetween: [ann.id, grace.id],
      },
      grace.token,
    );
    await record(
      flat,
      {
        description: 'April rent',
        amount: 100000,
        date: '2026-04-01',
        category: 'rent',
        splitBetween: [ann.id, grace.id],
      },
      ann.token,
    );
    await record(
      trip,
      { description: 'Train', amount: 50000, date: '2026-04-15', category: 'travel', splitBetween: [ann.id, grace.id] },
      grace.token,
    );

    const answer = await insightsOf(ann.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 3500 },
      { month: '2026-04', currency: 'EUR', category: 'rent', amount: 50000 },
    ]);
  });

  it('leaves out deleted expenses and the groups a person has left', async () => {
    const ben = await signedInPerson('Ben');
    const owner = await signedInPerson('Owen');
    const gym = await groupWith(owner, [ben]);

    const alone = idOf(
      await record(
        gym,
        { description: 'Kit', amount: 1200, date: '2026-05-03', category: 'leisure', splitBetween: [ben.id] },
        ben.token,
      ),
    );
    await record(
      gym,
      { description: 'Shared', amount: 600, date: '2026-05-04', category: 'food', splitBetween: [ben.id, owner.id] },
      owner.token,
    );

    expect((await insightsOf(ben.token)).body).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'food', amount: 300 },
      { month: '2026-05', currency: 'EUR', category: 'leisure', amount: 1200 },
    ]);

    await http.request('DELETE', `${api}/expenses/${alone}`, { token: ben.token });
    expect((await insightsOf(ben.token)).body).toEqual([
      { month: '2026-05', currency: 'EUR', category: 'food', amount: 300 },
    ]);
  });

  it('counts nothing for a group the person has left, and each person reads their own only', async () => {
    const cy = await signedInPerson('Cy');
    const dan = await signedInPerson('Dan');
    const club = await groupWith(dan, [cy]);
    await record(
      club,
      { description: 'Dues', amount: 900, date: '2026-06-01', category: 'other', splitBetween: [cy.id] },
      cy.token,
    );

    expect((await insightsOf(cy.token)).body).toEqual([
      { month: '2026-06', currency: 'EUR', category: 'other', amount: 900 },
    ]);
    expect((await insightsOf(dan.token)).body).toEqual([]);

    // Cy's balance is 0 once the dues are the only expense and Cy pays them alone: leaving is then allowed.
    await record(
      club,
      { description: 'Snacks', amount: 200, date: '2026-06-02', category: 'food', splitBetween: [cy.id] },
      cy.token,
    );
    expect((await http.request('POST', `${api}/groups/${club}/leave`, { token: cy.token })).status).toBeLessThan(300);
    expect((await insightsOf(cy.token)).body).toEqual([]);
  });

  it('answers 401 to a caller who is not signed in', async () => {
    expect((await insightsOf()).status).toBe(401);
  });
});
