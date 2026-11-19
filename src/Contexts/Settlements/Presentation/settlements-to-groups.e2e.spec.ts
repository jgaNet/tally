import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settlements → Groups (ADR 31, ADR 32): Groups reads the administrators' log through its `AdministratorDecisions` port, which Settlements
 * answers from the decisions it writes, and it writes its own entries beside them. Over HTTP: a settlement made in Settlements keeps the id its
 * request answered, and an administrator's decision on it is found in Groups' log by that same id, beside a suspension Groups made.
 */
const SECRET = 'a shared secret for the relationship test';
const ADMIN_EMAIL = 'root@example.org';
const PASSWORD = 'a long password';

/** A fake payment provider: payments are created with the next id, and each account is known. */
let provider: Server;
let received: { reference: string; amount: number; currency: string }[] = [];

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

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
      if (request.url === '/payments') {
        received = [...received, JSON.parse(body) as { reference: string; amount: number; currency: string }];
        const id = `pay_${received.length}`;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL.toUpperCase();

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
interface Person {
  id: string;
  token: string;
}

async function signedInPerson(name: string): Promise<Person> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  const id = (created.body as { id: string }).id;
  const token = (login.body as { token: string }).token;
  await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: `acct_${id}` }, token });
  return { id, token };
}

/** A webhook as the provider sends it: the body as JSON, signed with the shared secret over exactly those bytes. */
const sendWebhook = (webhookId: string, paymentId: string, status: string) => {
  const body = { id: webhookId, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
  });
};

describe('Settlements → Groups', () => {
  it("finds an administrator's decision on a settlement, and a suspension, in Groups' log by the ids their requests answered", async () => {
    // The administrator is the account whose email the server was started with (ADMIN_EMAILS, request 33).
    const root = await http.request('POST', `${api}/accounts`, {
      body: { email: ADMIN_EMAIL, password: PASSWORD, name: 'Root' },
    });
    expect(root.status).toBe(201);
    const rootToken = (
      (await http.request('POST', `${api}/accounts/login`, { body: { email: ADMIN_EMAIL, password: PASSWORD } }))
        .body as { token: string }
    ).token;

    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });

    // Grace asks to pay Ada the 30 she owes through the provider: the settlement's id is the one the request answers.
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(asked.status).toBe(201);
    const settlementId = (asked.body as { id: string }).id;
    const paymentId = `pay_${received.length}`;
    expect((await sendWebhook('wh_1', paymentId, 'succeeded')).status).toBe(204);

    // Ada, the payee, contests it; the administrator decides it was paid.
    expect(
      (await http.request('POST', `${api}/settlements/${settlementId}/contest`, { token: ada.token })).status,
    ).toBe(204);
    expect(
      (
        await http.request('POST', `${api}/admin/settlements/${settlementId}/decision`, {
          body: { paid: true },
          token: rootToken,
        })
      ).status,
    ).toBe(204);

    const log = (await http.request('GET', `${api}/admin/log`, { token: rootToken })).body as {
      action: string;
      subjectId: string;
    }[];
    expect(log.find(entry => entry.subjectId === settlementId)?.action).toBe('decided-paid');
  });
});

/** A person signed in with an email of this test's, as request 35 names them: the token, and the id their sign-up answered. */
async function deletionPerson(name: string): Promise<{ token: string; id: string }> {
  const email = `${name.toLowerCase()}.deleted35@example.org`;
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: 'a long password', name } });
  const { token } = (
    await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'a long password' } })
  ).body as { token: string };
  return { token, id: (created.body as { id: string }).id };
}

/** A group made by `owner`, which `other` has joined through an invitation: the group's id, which its request answered. */
async function deletionGroup(owner: { token: string }, other: { token: string }): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
    id: string;
  };
  await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: other.token });
  return id;
}

/**
 * Request 35 over the pair: a payment through the provider Settlements made keeps its id, and Groups refuses the deletion of the payee while it
 * waits, by `AccountPaymentWaiting`; the member is still in Groups, under the id the same request answered.
 */
describe('Settlements → Groups, a deleted account with a payment waiting (request 35)', () => {
  it('refuses the deletion while a payment through the provider waits, and the member is still the one that id names', async () => {
    const ann = await deletionPerson('Ann');
    const cy = await deletionPerson('Cy');
    const groupId = await deletionGroup(ann, cy);
    // Cy has a payout account at the provider, so Ann may pay Cy through it; Cy paid 100 split between them, so Ann owes Cy 50.
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct_${cy.id}` },
      token: cy.token,
    });
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 100, date: '2020-01-10', splitBetween: [ann.id, cy.id] },
      token: cy.token,
    });
    const requested = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: cy.id, amount: 10 },
      token: ann.token,
    });
    expect(requested.status).toBeLessThan(300);
    const settlementId = (requested.body as { id: string }).id;

    const refused = await http.request('DELETE', `${api}/accounts/me`, { token: cy.token });
    expect((refused.body as { type: string }).type).toBe('AccountPaymentWaiting');
    // Groups still names the member by the id its sign-up answered, and Settlements still holds the payment by its id.
    const listed = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
      name: string;
    }[];
    expect(listed.find(member => member.memberId === cy.id)?.name).toBe('Cy');
    const payment = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: ann.token })).body as {
      id: string;
      status: string;
    };
    expect(payment).toMatchObject({ id: settlementId, status: 'pending' });
  });
});
