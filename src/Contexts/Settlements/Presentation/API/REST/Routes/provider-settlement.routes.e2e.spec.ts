import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settling up through the payment provider, end to end (request 13): the application booted in this process, spoken to over HTTP,
 * every answer held to api/13-pay-through-the-provider.yaml by the client. The provider is a fake one, a server in this process,
 * started before the application is, so PROVIDER_URL and PROVIDER_WEBHOOK_SECRET are the ones the application reads at its start.
 */
const SECRET = 'whsec_test';
const SPENT = '2020-01-02';
const PASSWORD = 'correct horse';

/** What the fake provider answers its next payment request with: a link, a refusal, or no answer in time. */
let answer: 'link' | 'refuse' | 'slow' = 'link';
let requested: { reference: string; amount: number; currency: string }[] = [];
/** The payment ids the fake provider issued, in order: each test's payment is the last one issued. */
let issued: string[] = [];
const lastPayment = () => issued[issued.length - 1];
/** The id of the next payment the fake provider issues: a new one for every payment, across the tests. */
let issuedCount = 0;
const nextPaymentId = (): string => {
  issuedCount += 1;
  issued.push(`pay_${issuedCount}`);
  return issued[issued.length - 1];
};
let provider: Server;
let providerUrl: string;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string };
      requested.push(body);
      if (answer === 'refuse') return void res.writeHead(500).end();
      const reply = () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(((id: string) => ({ id, payUrl: `https://provider.test/pay/${id}` }))(nextPaymentId())));
      };
      if (answer === 'slow') setTimeout(reply, 5500);
      else reply();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.PROVIDER_URL = providerUrl;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

beforeEach(() => {
  answer = 'link';
  requested = [];
  issued = [];
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    expect((await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token })).status).toBe(
      201,
    );
  }
  return groupId;
}

const payThroughProvider = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/provider`, { body, token });
const settleInCash = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/cash`, { body, token });
/** The outcome of an operation read through `GET /v1/operations/:id`, once it is no longer pending. */
async function operationOutcome(operationId: string, token: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const read = await http.get(`/v1/operations/${operationId}`, { token });
    const operation = read.body as { status: string; error?: { type: string; message: string } };
    if (operation.status !== 'PENDING') return { status: 400, body: operation.error };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('the operation did not end');
}

const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];
const suggestedOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/settlements/suggested`, { token })).body;

/** The provider's webhook, signed as the provider signs it: HMAC-SHA256 of the body as sent, in lowercase hex. */
const webhook = (body: { id?: string; paymentId: string; status: string; at?: string }, signature?: string) =>
  http.request('POST', '/v1/provider/webhooks', {
    body: { id: body.id ?? `wh_${body.paymentId}_${body.status}`, at: body.at ?? '2026-11-17T10:00:00Z', ...body },
    headers: {
      'provider-signature':
        signature ??
        createHmac('sha256', SECRET)
          .update(
            JSON.stringify({
              id: body.id ?? `wh_${body.paymentId}_${body.status}`,
              at: body.at ?? '2026-11-17T10:00:00Z',
              ...body,
            }),
          )
          .digest('hex'),
    },
  });

/** Ann paid 60 for both of them: Bob owes Ann 30. */
async function annAndBobOwing(): Promise<{
  ann: { token: string; id: string };
  bob: { token: string; id: string };
  groupId: string;
}> {
  const ann = await accountOf('ann.provider@example.com', 'Ann');
  const bob = await accountOf('bob.provider@example.com', 'Bob');
  const groupId = await groupWith(ann, [bob]);
  const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  expect(expense.status).toBe(201);
  return { ann, bob, groupId };
}

describe('Settlements → Ledger', () => {
  it('counts a payment through the provider in the balances once the provider says it succeeded, and not before', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();

    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    expect(asked.status).toBe(201);
    const id = (asked.body as { id: string }).id;

    // Waiting at the provider, the payment is not counted by the balances yet.
    expect((await balancesOf(groupId, ann.token)).find(b => b.memberId === bob.id)?.balance).toBe(-30);
    const read = await http.get(`/v1/settlements/${id}`, { token: bob.token });
    expect(read.body).toMatchObject({
      id,
      method: 'provider',
      status: 'pending',
      payUrl: `https://provider.test/pay/${lastPayment()}`,
    });

    expect((await webhook({ paymentId: lastPayment(), status: 'succeeded' })).status).toBeGreaterThanOrEqual(200);
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
    expect((await http.get(`/v1/settlements/${id}`, { token: ann.token })).body).toMatchObject({ status: 'paid' });
  });
});

describe('Groups → Settlements', () => {
  it('asks the provider in the group currency, for the settlement it names, and refuses a payment to whom nothing is owed', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();

    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    expect(asked.status).toBe(201);
    expect(requested).toEqual([{ reference: (asked.body as { id: string }).id, amount: 30, currency: 'EUR' }]);

    // Nothing is owed to the stranger, so nothing is paid to them, and the provider is not asked.
    const stranger = await accountOf('stranger.provider@example.com', 'Stranger');
    const refused = await payThroughProvider(groupId, bob.token, { to: stranger.id, amount: 1 });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'SettlementExceedsBalance', message: expect.any(String) });
    expect(requested).toHaveLength(1);
  });

  it('is not found by someone outside the group, and asks no provider for them', async () => {
    const { ann, groupId } = await annAndBobOwing();
    const outsider = await accountOf('outsider.provider@example.com', 'Outsider');
    expect((await payThroughProvider(groupId, outsider.token, { to: ann.id, amount: 30 })).status).toBe(404);
    expect(requested).toEqual([]);
  });
});

describe('Ledger → Settlements', () => {
  it('suggests no transfer for a payment waiting at the provider, and the transfer again once it failed', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    expect(await suggestedOf(groupId, ann.token)).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);

    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    expect(asked.status).toBe(201);
    expect(await suggestedOf(groupId, ann.token)).toEqual([]);

    const id = (asked.body as { id: string }).id;
    expect((await webhook({ paymentId: lastPayment(), status: 'failed' })).status).toBeGreaterThanOrEqual(200);
    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'failed' });
    expect(await suggestedOf(groupId, ann.token)).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
    expect((await balancesOf(groupId, ann.token)).find(b => b.memberId === bob.id)?.balance).toBe(-30);
  });

  it('counts a payment waiting at the provider as paid for a cash settlement too: nothing more can be paid of it', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    expect((await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 })).status).toBe(201);

    const cash = await settleInCash(groupId, ann.token, { from: bob.id, amount: 1 });
    expect(cash.status).toBe(400);
    expect(cash.body).toEqual({ type: 'SettlementExceedsBalance', message: expect.any(String) });
  });
});

describe('a payment through the provider', () => {
  it('is refused, and nothing is kept, when the provider gives no link', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    answer = 'refuse';

    const refused = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    expect(await suggestedOf(groupId, ann.token)).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
  });

  it('is refused when the provider does not answer within 5 seconds', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    answer = 'slow';

    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const operationId = (asked.body as { operationId?: string }).operationId;
    // Answered at the route's own deadline, the refusal is read at its operation, as any command answered later.
    const refused = operationId ? await operationOutcome(operationId, bob.token) : asked;
    expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    expect(await suggestedOf(groupId, ann.token)).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
  }, 20000);

  it('is refused, and the provider is not asked, when no provider is configured', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const configured = process.env.PROVIDER_URL;
    process.env.PROVIDER_URL = '';
    try {
      const refused = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
      expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    } finally {
      process.env.PROVIDER_URL = configured;
    }
    expect(requested).toEqual([]);
  });

  it('is refused for an amount that is not a whole number of at least 1, or a payee who is the payer', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    expect((await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 0 })).status).toBe(400);
    expect((await payThroughProvider(groupId, bob.token, { to: bob.id, amount: 1 })).status).toBe(400);
    expect(requested).toEqual([]);
  });
});

describe('a webhook of the provider', () => {
  it('is refused with 401, and changes nothing, when its signature is missing or wrong', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;

    const body = { id: 'wh_1', paymentId: lastPayment(), status: 'succeeded', at: '2026-11-17T10:00:00Z' };
    const missing = await http.request('POST', '/v1/provider/webhooks', { body });
    const wrong = await http.request('POST', '/v1/provider/webhooks', {
      body,
      headers: {
        'provider-signature': createHmac('sha256', 'another-secret').update(JSON.stringify(body)).digest('hex'),
      },
    });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'pending' });
  });

  it('is acknowledged with 2xx, and changes nothing, for a payment Tally does not know or a status still pending', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    expect((await webhook({ paymentId: 'pay_unknown', status: 'succeeded' })).status).toBe(201);
    expect((await webhook({ paymentId: lastPayment(), status: 'pending' })).status).toBe(201);

    const id = (asked.body as { id: string }).id;
    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'pending' });
  });
});
