import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationships request 33 carries, over HTTP (ADR 28): a decision an administrator makes in Settlements is read by Groups' administrators'
 * log by the id the decision's settlement answered, and a contested payment waits at the provider for Groups, which keeps its payer in the group.
 * Each relationship of the context map is named by its title, so that the gate can see the test that holds it.
 */
let provider: Server;
let providerUrl: string;
let paymentsByReference: Map<string, string>;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let webhooks: number;

const SECRET = 'a secret for the links of request 33';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  let payments = 0;
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: decodeURIComponent(account[1]) }));
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text || '{}') as { reference?: string };
      payments += 1;
      const id = `pay-${payments}`;
      paymentsByReference.set(body.reference as string, id);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({
    databaseUrl: await freshDatabase(),
    logger: silent,
    providerUrl,
    providerWebhookSecret: SECRET,
    administratorEmails: ['admin@example.com'],
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  admin = await person('Admin', 'admin@example.com');
  paymentsByReference = new Map();
  webhooks = 0;
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    token,
    body: { accountId: `acct-${name.toLowerCase()}` },
  });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let admin: Awaited<ReturnType<typeof person>>;

/** A group of Ann and Bob in which Ann paid 2000 for both: Bob owes Ann 1000. */
async function twoOwing() {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Pair', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: ann.token,
    body: { description: 'Lunch', amount: 2000, date: '2020-01-15', splitBetween: [ann.id, bob.id] },
  });
  return groupId;
}

/** Bob pays Ann 1000 through the provider, which says it succeeded: the settlement's id, and the payment's id. */
async function bobPaysAnn(groupId: string) {
  const { body } = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    token: bob.token,
    body: { to: ann.id, amount: 1000 },
  });
  const id = (body as { id: string }).id;
  const payment = paymentsByReference.get(id) as string;
  const webhookBody = {
    id: `wh-${(webhooks += 1)}`,
    paymentId: payment,
    status: 'succeeded',
    at: '2026-03-01T10:00:00.000Z',
  };
  await http.request('POST', `${api}/provider/webhooks`, {
    body: webhookBody,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(webhookBody)).digest('hex') },
  });
  return id;
}

describe('Settlements → Groups (AdministratorDecisions)', () => {
  it("a decision made in Settlements is in the administrators' log Groups reads, by the id the settlement answered", async () => {
    const groupId = await twoOwing();
    const settlementId = await bobPaysAnn(groupId);
    expect(
      (await http.request('POST', `${api}/settlements/${settlementId}/contest`, { token: ann.token })).status,
    ).toBe(204);
    expect(
      (
        await http.request('POST', `${api}/admin/settlements/${settlementId}/decision`, {
          token: admin.token,
          body: { paid: false },
        })
      ).status,
    ).toBe(204);

    const log = (await http.request('GET', `${api}/admin/log`, { token: admin.token })).body as {
      id: string;
      at: string;
      by: string;
      action: string;
      subjectId: string;
    }[];
    expect(log.filter(entry => entry.subjectId === settlementId)).toEqual([
      {
        id: `decision:${settlementId}`,
        at: expect.any(String),
        by: admin.id,
        action: 'decided-annulled',
        subjectId: settlementId,
      },
    ]);
    // Oldest first: an entry is never placed before one made earlier.
    const times = log.map(entry => entry.at);
    expect(times).toEqual([...times].sort());
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('a payment contested by its payee waits for Groups: its payer cannot leave until an administrator decides', async () => {
    const groupId = await twoOwing();
    const settlementId = await bobPaysAnn(groupId);
    expect(
      (await http.request('POST', `${api}/settlements/${settlementId}/contest`, { token: ann.token })).status,
    ).toBe(204);

    expect(
      (await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status,
    ).toBeGreaterThanOrEqual(400);

    expect(
      (
        await http.request('POST', `${api}/admin/settlements/${settlementId}/decision`, {
          token: admin.token,
          body: { paid: true },
        })
      ).status,
    ).toBe(204);
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBeLessThan(
      300,
    );
  });
});
