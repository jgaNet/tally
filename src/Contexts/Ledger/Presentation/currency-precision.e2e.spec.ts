import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 40 over HTTP: a group in a currency with no minor unit or with three decimals, and an expense paid in another currency of
 * different precision, counted in the group's own minor unit (ADR 38). The answers are held to `api/` through `apiClient()`.
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

/** A group in `currency` owned by `owner`, which each of `others` has joined through an invitation. */
async function groupIn(owner: { token: string }, others: { token: string }[], currency: string): Promise<string> {
  const { id } = (await http.request('POST', `${api}/groups`, { body: { name: 'Trip', currency }, token: owner.token }))
    .body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

describe('a group in a currency with no minor unit or with three decimals (request 40)', () => {
  it('is created in JPY, KRW, KWD and BHD, and answered with its currency', async () => {
    const ada = await signedInPerson('Ada');
    for (const currency of ['JPY', 'KRW', 'KWD', 'BHD']) {
      const created = await http.request('POST', `${api}/groups`, {
        body: { name: 'Trip', currency },
        token: ada.token,
      });
      expect(created.status).toBe(201);
      const read = await http.request('GET', `${api}/groups/${(created.body as { id: string }).id}`, {
        token: ada.token,
      });
      expect(read.body).toEqual(expect.objectContaining({ currency }));
    }
  });
});

describe('an expense in another currency of different precision (request 40)', () => {
  it('counts 1250 euros in a yen group, at 161.5, as 2019 yen, and keeps the original as it was paid', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupIn(ada, [grace], 'JPY');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Ramen',
        original: { currency: 'EUR', amount: 1250, rate: '161.5' },
        date: '2026-11-16',
        splitBetween: [ada.id, grace.id],
      },
      token: ada.token,
    });
    expect(answer.status).toBe(201);

    const read = await http.request('GET', `${api}/expenses/${(answer.body as { id: string }).id}`, {
      token: ada.token,
    });
    expect(read.body).toEqual(
      expect.objectContaining({
        amount: 2019,
        original: { currency: 'EUR', amount: 1250, rate: '161.5' },
      }),
    );
  });

  it('counts 10 dollars in a dinar group, at 0.3075, as 3075 thousandths of a dinar', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupIn(ada, [grace], 'KWD');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Souq',
        original: { currency: 'USD', amount: 1000, rate: '0.3075' },
        date: '2026-11-16',
        splitBetween: [ada.id, grace.id],
      },
      token: ada.token,
    });
    expect(answer.status).toBe(201);

    const read = await http.request('GET', `${api}/expenses/${(answer.body as { id: string }).id}`, {
      token: ada.token,
    });
    expect(read.body).toEqual(expect.objectContaining({ amount: 3075 }));
  });

  it('counts 10 000 yen in a euro group, at 0.0062, as 6200 cents', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupIn(ada, [grace], 'EUR');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Onsen',
        original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
        date: '2026-11-16',
        splitBetween: [ada.id, grace.id],
      },
      token: ada.token,
    });
    expect(answer.status).toBe(201);

    const read = await http.request('GET', `${api}/expenses/${(answer.body as { id: string }).id}`, {
      token: ada.token,
    });
    expect(read.body).toEqual(expect.objectContaining({ amount: 6200 }));
  });
});
