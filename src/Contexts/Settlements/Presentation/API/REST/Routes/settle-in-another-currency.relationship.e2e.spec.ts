import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationships of a settlement paid in another currency (request 39): Settlements reads the currency of the group Groups
 * made (GroupCurrency), and the members of it (SettlementMembers), to decide the amount in the group's currency.
 */
let provider: Server;
let rates: Server;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

type Body = Record<string, unknown>;

beforeAll(async () => {
  provider = createServer((req, res) => {
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  rates = createServer((req, res) => {
    const match = /^\/rates\/([A-Z]{3})\/([A-Z]{3})\?/.exec(req.url ?? '');
    if (req.method !== 'GET' || !match || `${match[1]}-${match[2]}` !== 'CHF-EUR') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rate: '0.9542' }));
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.RATES_URL = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'another-currency-relationship-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
  rates.close();
});

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `another-currency-relationship-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

describe('Groups → Settlements (GroupCurrency, SettlementMembers): a group Groups makes is the one Settlements reads, by the id it answered', () => {
  it('settles in another currency in the group Groups made, in its currency, and lists it by the id the group answered', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');

    // Groups makes the group, and its id is the one the request answered.
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Trip', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (
      (await outcome((created.body as Body).operationId as string, ann.token)).body as { result: { id: string } }
    ).result.id;

    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invited = await outcome((invitation.body as Body).operationId as string, ann.token);
    const accepted = await http.request(
      'POST',
      `${api}/invitations/${(invited.body as { result: { id: string } }).result.id}/accept`,
      {
        token: bob.token,
      },
    );
    await outcome((accepted.body as Body).operationId as string, bob.token);

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 6000, date: serverToday, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    await outcome((recorded.body as Body).operationId as string, ann.token);

    // Settlements reads the group's currency from Groups, and converts the CHF payment into it.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, original: { currency: 'CHF', amount: 2500 } },
      token: ann.token,
    });
    expect((await outcome((paid.body as Body).operationId as string, ann.token)).body).toMatchObject({
      status: 'SUCCESS',
    });

    // Listed by the group's id, the settlement is in the group's currency, with the original kept.
    const listed = await http.get(`${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        groupId,
        method: 'cash',
        amount: 2386,
        original: { currency: 'CHF', amount: 2500, rate: '0.9542' },
      }),
    ]);
  });
});
