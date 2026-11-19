import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('currency-precision');

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
const PAST = '2026-01-15';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group in `currency`, with its owner as first member, and each given account joined by an invitation. */
async function groupIn(currency: string, owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, { body: { name: 'Trip', currency }, token: owner.token });
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
const readExpense = (id: string, token: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('currencies of any minor unit (request 40)', () => {
  it('allows a group in yen, won, dinars and dinars of Bahrain, and refuses one that is not a currency of Tally', async () => {
    const ada = await signedIn('cp-ada@example.com', 'Ada');
    for (const currency of ['JPY', 'KRW', 'KWD', 'BHD']) {
      const created = await http.request('POST', `${api}/groups`, {
        body: { name: 'Trip', currency },
        token: ada.token,
      });
      expect(created.status).toBe(201);
      const read = await http.request('GET', `${api}/groups/${(created.body as { id: string }).id}`, {
        token: ada.token,
      });
      expect(read.body).toMatchObject({ currency });
    }
    const refused = await http.request('POST', `${api}/groups`, {
      body: { name: 'Trip', currency: 'XYZ' },
      token: ada.token,
    });
    expect(refused).toMatchObject({ status: 422, body: { type: 'InvalidCurrency' } });
  });

  it('keeps an amount in a yen group in yen, and converts an euro original to yen, to the nearest yen', async () => {
    const ada = await signedIn('cp-jpy-ada@example.com', 'Ada');
    const bob = await signedIn('cp-jpy-bob@example.com', 'Bob');
    const groupId = await groupIn('JPY', ada, [bob]);

    const yen = await record(ada.token, groupId, {
      description: 'Ramen',
      amount: 3000,
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    expect(yen.status).toBe(201);
    expect(await readExpense((yen.body as { id: string }).id, ada.token)).toMatchObject({ body: { amount: 3000 } });

    // 12.50 euros (1250) at 161.5 yen each is 2018.75 yen: 2019 yen.
    const euros = await record(ada.token, groupId, {
      description: 'Museum',
      original: { currency: 'EUR', amount: 1250, rate: '161.5' },
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    expect(euros.status).toBe(201);
    expect(await readExpense((euros.body as { id: string }).id, ada.token)).toMatchObject({
      body: { amount: 2019, original: { currency: 'EUR', amount: 1250, rate: '161.5' } },
    });
  });

  it('converts a dollar original to dinars, in thousandths, and keeps a dinar amount in thousandths', async () => {
    const ada = await signedIn('cp-kwd-ada@example.com', 'Ada');
    const bob = await signedIn('cp-kwd-bob@example.com', 'Bob');
    const groupId = await groupIn('KWD', ada, [bob]);

    const dinars = await record(ada.token, groupId, {
      description: 'Taxi',
      amount: 1250,
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    expect(await readExpense((dinars.body as { id: string }).id, ada.token)).toMatchObject({ body: { amount: 1250 } });

    // 10 dollars (1000) at 0.3075 dinars each is 3.075 dinars: 3075 thousandths.
    const dollars = await record(ada.token, groupId, {
      description: 'Hotel',
      original: { currency: 'USD', amount: 1000, rate: '0.3075' },
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    expect(await readExpense((dollars.body as { id: string }).id, ada.token)).toMatchObject({ body: { amount: 3075 } });
  });

  it('converts a yen original to a euro group: 10 000 yen at 0.0062 euros each is 62 euros, in cents', async () => {
    const ada = await signedIn('cp-eur-ada@example.com', 'Ada');
    const bob = await signedIn('cp-eur-bob@example.com', 'Bob');
    const groupId = await groupIn('EUR', ada, [bob]);

    const yen = await record(ada.token, groupId, {
      description: 'Sushi',
      original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    expect(yen.status).toBe(201);
    expect(await readExpense((yen.body as { id: string }).id, ada.token)).toMatchObject({
      body: { amount: 6200, original: { currency: 'JPY', amount: 10000, rate: '0.0062' } },
    });
  });
});
