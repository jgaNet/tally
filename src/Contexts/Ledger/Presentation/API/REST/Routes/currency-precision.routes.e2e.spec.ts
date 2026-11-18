import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Currencies with no minor unit or with three decimals, end to end (request 40): a group in yen or dinars, an expense paid in
 * another currency converted into the group's minor unit, every answer held to api/40-currency-precision.yaml by the client.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function groupIn(currency: string, owner: { token: string }): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: `Counted in ${currency}`, currency },
    token: owner.token,
  });
  expect(created.status).toBe(201);
  return (created.body as { id: string }).id;
}

describe('Groups: a group in a currency with no minor unit or with three decimals (request 40)', () => {
  it('counts a yen group in yen, and reads its currency back as JPY', async () => {
    const ana = await signedIn('ana.yen@example.com', 'Ana');
    const groupId = await groupIn('JPY', ana);

    expect(await http.get(`/v1/groups/${groupId}`, { token: ana.token })).toMatchObject({
      status: 200,
      body: { currency: 'JPY' },
    });
  });

  it('records an expense of 1250 yen as 1250 yen, and an expense of 12.50 euros in a yen group as 2019 yen', async () => {
    const ana = await signedIn('ana.yen.expense@example.com', 'Ana');
    const groupId = await groupIn('JPY', ana);

    const inYen = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      token: ana.token,
      body: { description: 'Ramen', amount: 1250, date: SPENT, splitBetween: [ana.id] },
    });
    expect(inYen.status).toBe(201);
    expect(await http.get(`/v1/expenses/${(inYen.body as { id: string }).id}`, { token: ana.token })).toMatchObject({
      status: 200,
      body: { amount: 1250 },
    });

    const inEuros = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      token: ana.token,
      body: {
        description: 'Train',
        original: { currency: 'EUR', amount: 1250, rate: '161.5' },
        date: SPENT,
        splitBetween: [ana.id],
      },
    });
    expect(inEuros.status).toBe(201);
    expect(await http.get(`/v1/expenses/${(inEuros.body as { id: string }).id}`, { token: ana.token })).toMatchObject({
      status: 200,
      body: { amount: 2019, original: { currency: 'EUR', amount: 1250, rate: '161.5' } },
    });
  });

  it('records 10 dollars in a dinar group as 3075 thousandths of a dinar', async () => {
    const ana = await signedIn('ana.dinar@example.com', 'Ana');
    const groupId = await groupIn('KWD', ana);

    const recorded = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      token: ana.token,
      body: {
        description: 'Dinner',
        original: { currency: 'USD', amount: 1000, rate: '0.3075' },
        date: SPENT,
        splitBetween: [ana.id],
      },
    });
    expect(recorded.status).toBe(201);
    expect(await http.get(`/v1/expenses/${(recorded.body as { id: string }).id}`, { token: ana.token })).toMatchObject({
      status: 200,
      body: { amount: 3075 },
    });
  });
});
