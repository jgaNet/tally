import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settlements → Groups over WaitingPayments (request 31, ADR 28): a group whose payment through the provider is pending is not merged while
 * it is, and is still there, unchanged. The payment is found by the id its request answered.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;

beforeAll(async () => {
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
      return;
    }
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const payment = JSON.parse(body) as { reference: string };
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ id: `pay_${payment.reference}`, payUrl: `https://pay.example/pay_${payment.reference}` }),
      );
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.DATABASE_URL = await freshDatabaseUrl();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
});

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  const id = (created.body as { id: string }).id;
  await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: `acct_${id}` }, token });
  return { token, id };
}

describe('Settlements → Groups', () => {
  it('refuses the merge of a group whose payment through the provider is pending, and changes nothing', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const kept = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const merged = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Annex', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${merged.id}/invitations`, { token: ada.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    await http.request('POST', `${api}/groups/${merged.id}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2020-03-03', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const asked = await http.request('POST', `${api}/groups/${merged.id}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id: settlementId } = asked.body as { id: string };

    const refused = (
      await http.request('POST', `${api}/groups/${kept.id}/merge`, { body: { from: merged.id }, token: ada.token })
    ).body as { type: string };
    expect(refused.type).toBe('PaymentsWaiting');
    expect((await http.request('GET', `${api}/groups/${merged.id}`, { token: ada.token })).status).toBe(200);
    const pending = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: grace.token })).body as {
      status: string;
    };
    expect(pending.status).toBe('pending');
  });
});
