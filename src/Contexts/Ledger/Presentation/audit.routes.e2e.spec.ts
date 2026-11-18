import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 28 over HTTP, across Ledger, Settlements and Groups: every change of money in a group is an entry of its audit, written with the
 * change, and a member reads them, the oldest first. A change refused, or one that changes nothing, has none.
 */
const SECRET = 'a shared secret for the audit test';

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
  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
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

/** A group of an owner, `grace` and `linus` who joined, with a dinner of 60 the owner paid and split with `grace`: `grace` owes 30. */
async function groupWithADinner() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  expect(recorded.status).toBe(201);
  const expenses = (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ada.token })).body as {
    id: string;
  }[];
  return { ada, grace, linus, groupId, expenseId: expenses[0].id };
}

const auditOf = (groupId: string, token: string) => http.request('GET', `${api}/groups/${groupId}/audit`, { token });

/** The provider's signed webhook about a payment, over exactly the bytes it sends. */
const sendWebhook = (webhookId: string, paymentId: string, status: string) => {
  const body = { id: webhookId, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
  });
};

describe('the audit of a group', () => {
  it('holds the expense recorded, edited and then the cash settlement, each with who made it, when, and how much, the oldest first', async () => {
    const { ada, grace, groupId, expenseId } = await groupWithADinner();
    const edited = await http.request('PUT', `${api}/expenses/${expenseId}`, {
      body: { description: 'Dinner', amount: 90, date: '2020-01-15', splitBetween: [ada.id, grace.id], version: 1 },
      token: ada.token,
    });
    expect(edited.status).toBeLessThan(300);
    const settled = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 30 },
      token: ada.token,
    });
    const { id: settlementId } = settled.body as { id: string };

    const audit = await auditOf(groupId, grace.token);
    expect(audit.status).toBe(200);
    expect(audit.body).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
        by: ada.id,
        action: 'expense-recorded',
        subjectId: expenseId,
        amount: 60,
      },
      {
        id: expect.any(String),
        at: expect.any(String),
        by: ada.id,
        action: 'expense-edited',
        subjectId: expenseId,
        amount: 90,
      },
      {
        id: expect.any(String),
        at: expect.any(String),
        by: ada.id,
        action: 'settlement-paid',
        subjectId: settlementId,
        amount: 30,
      },
    ]);
  });

  it('holds the expense deleted with the amount it had, and keeps the entry of its recording', async () => {
    const { ada, groupId, expenseId } = await groupWithADinner();
    expect((await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: ada.token })).status).toBe(204);

    const audit = (await auditOf(groupId, ada.token)).body as { action: string; amount: number; subjectId: string }[];
    expect(audit.map(entry => [entry.action, entry.amount, entry.subjectId])).toEqual([
      ['expense-recorded', 60, expenseId],
      ['expense-deleted', 60, expenseId],
    ]);
  });

  it('counts a provider payment as paid by its payer once the provider says it succeeded, and its refund by its payee', async () => {
    const { ada, grace, groupId } = await groupWithADinner();
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id: settlementId } = asked.body as { id: string };
    const { payUrl } = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: grace.token }))
      .body as { payUrl: string };
    const paymentId = payUrl.slice(payUrl.lastIndexOf('/') + 1);

    // Waiting at the provider, nothing of the payment is in the audit yet.
    const waiting = (await auditOf(groupId, ada.token)).body as { action: string }[];
    expect(waiting.map(entry => entry.action)).toEqual(['expense-recorded']);

    expect((await sendWebhook('evt_paid', paymentId, 'succeeded')).status).toBe(204);
    // A webhook said twice changes nothing, so it adds no entry.
    expect((await sendWebhook('evt_paid_again', paymentId, 'succeeded')).status).toBe(204);
    const paid = (await auditOf(groupId, ada.token)).body as { action: string; by: string; amount: number }[];
    expect(paid.slice(1)).toMatchObject([
      { action: 'settlement-paid', by: grace.id, subjectId: settlementId, amount: 30 },
    ]);
    expect(paid).toHaveLength(2);

    expect((await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: ada.token })).status).toBe(
      204,
    );
    expect((await sendWebhook('evt_refunded', paymentId, 'refunded')).status).toBe(204);
    const refunded = (await auditOf(groupId, ada.token)).body as { action: string; by: string; subjectId: string }[];
    expect(refunded.slice(2)).toMatchObject([{ action: 'settlement-refunded', by: ada.id, subjectId: settlementId }]);
  });

  it('holds the balance that passed when a member left with one, and none for a member who left with nothing', async () => {
    const { ada, grace, linus, groupId } = await groupWithADinner();
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token })).status).toBe(204);
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: linus.token })).status).toBe(204);

    const audit = (await auditOf(groupId, ada.token)).body as {
      action: string;
      by: string;
      subjectId: string;
      amount: number;
    }[];
    expect(audit.slice(1)).toMatchObject([
      { action: 'balance-passed', by: grace.id, subjectId: grace.id, amount: -30 },
    ]);
    expect(audit).toHaveLength(2);
  });

  it('answers the group does not exist to anyone who is not a member, and 401 to no one signed in', async () => {
    const { groupId } = await groupWithADinner();
    const stranger = await signedInPerson('Stranger');
    expect((await auditOf(groupId, stranger.token)).status).toBe(404);
    expect((await http.request('GET', `${api}/groups/${groupId}/audit`)).status).toBe(401);
  });
});

describe('Settlements → Ledger', () => {
  it('finds the settlement Settlements recorded by the id its request answered, in the audit Ledger reads', async () => {
    const { ada, grace, groupId } = await groupWithADinner();
    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 30 },
      token: ada.token,
    });
    const { id: settlementId } = recorded.body as { id: string };

    const audit = (await auditOf(groupId, ada.token)).body as { action: string; subjectId: string; amount: number }[];
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'settlement-paid', subjectId: settlementId, amount: 30 }),
    );
  });
});

describe('Groups → Ledger', () => {
  it('finds the member Groups took out by the account id its sign-up answered, in the audit Ledger reads', async () => {
    const { ada, grace, groupId } = await groupWithADinner();
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token })).status).toBe(204);

    const audit = (await auditOf(groupId, ada.token)).body as { action: string; subjectId: string; amount: number }[];
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'balance-passed', subjectId: grace.id, amount: -30 }),
    );
  });
});
