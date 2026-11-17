import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settling up through the payment provider, end to end (requests 13 to 15): the application booted in this process, spoken to over HTTP,
 * every answer held to api/13-pay-through-the-provider.yaml, and api/15-refund-through-the-provider.yaml, by the client. The provider is a fake one, a server in this process,
 * started before the application is, so PROVIDER_URL and PROVIDER_WEBHOOK_SECRET are the ones the application reads at its start.
 */
const SECRET = 'whsec_test';
const SPENT = '2020-01-02';
const PASSWORD = 'correct horse';

/** What the fake provider answers its next payment request with: a link, a refusal, or no answer in time. */
let answer: 'link' | 'refuse' | 'slow' = 'link';
let requested: { reference: string; amount: number; currency: string; payee: string }[] = [];
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
/** What the fake provider answers its next refund request with: accepted, refused, or no answer in time (request 15). */
let refundAnswer: 'accept' | 'refuse' | 'slow' = 'accept';
/** What the fake provider answers a payout account asked of it with (request 16): known, unknown (`acct_unknown` is never known), refused, or no answer in time. */
let accountAnswer: 'answer' | 'refuse' | 'slow' = 'answer';
/** The payout accounts the fake provider was asked about, in order. */
let accountsAsked: string[] = [];
/** The refund requests the fake provider received, in order: the path asked, and the body sent. */
let refunds: { path: string; body: { reference: string } }[] = [];
let provider: Server;
let providerUrl: string;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/accounts/')) {
        const accountId = decodeURIComponent(req.url.slice('/accounts/'.length));
        accountsAsked.push(accountId);
        const answered = () => {
          if (accountAnswer === 'refuse') return void res.writeHead(500).end();
          if (accountId === 'acct_unknown' || !accountId.startsWith('acct_')) return void res.writeHead(404).end();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: accountId }));
        };
        if (accountAnswer === 'slow') setTimeout(answered, 5500);
        else answered();
        return;
      }
      if (req.url?.endsWith('/refunds')) {
        refunds.push({ path: req.url, body: JSON.parse(text) as { reference: string } });
        if (refundAnswer === 'refuse') return void res.writeHead(500).end();
        const refunded = () => {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: `rf_${refunds.length}` }));
        };
        if (refundAnswer === 'slow') setTimeout(refunded, 5500);
        else refunded();
        return;
      }
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string; payee: string };
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
  refundAnswer = 'accept';
  refunds = [];
  accountAnswer = 'answer';
  accountsAsked = [];
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

const setPayoutAccount = (token: string | undefined, accountId: unknown) =>
  http.request('PUT', '/v1/accounts/me/payout-account', { body: { accountId }, token });
const readPayoutAccount = (token?: string) => http.get('/v1/accounts/me/payout-account', { token });
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

const refundSettlement = (settlementId: string, token?: string) =>
  http.request('POST', `/v1/settlements/${settlementId}/refund`, { token });
const readSettlement = async (settlementId: string, token: string) =>
  (await http.get(`/v1/settlements/${settlementId}`, { token })).body as { status: string };

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
  // Ann is paid through the provider, so she has a payout account it knows (request 16).
  expect((await setPayoutAccount(ann.token, 'acct_ann')).status).toBe(201);
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
    expect(requested).toEqual([
      { reference: (asked.body as { id: string }).id, amount: 30, currency: 'EUR', payee: 'acct_ann' },
    ]);

    // Nothing is owed to the stranger, so nothing is paid to them, and the provider is not asked.
    const stranger = await accountOf('stranger.provider@example.com', 'Stranger');
    expect((await setPayoutAccount(stranger.token, 'acct_stranger')).status).toBe(201);
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

/** A webhook the provider sent, acknowledged: any 2xx, so that the provider stops sending it (request 14). */
const expectAcknowledged = (response: { status: number }) => expect([200, 201, 202, 204]).toContain(response.status);

describe('webhooks late, twice or out of order (request 14)', () => {
  it('counts a payment once, however many webhooks say it succeeded: the same webhook twice, or two under two ids', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();

    expectAcknowledged(await webhook({ id: 'wh_a', paymentId, status: 'succeeded' }));
    expectAcknowledged(await webhook({ id: 'wh_a', paymentId, status: 'succeeded' }));
    expectAcknowledged(await webhook({ id: 'wh_b', paymentId, status: 'succeeded' }));

    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'paid' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });

  it('keeps a paid payment paid when a pending or a failed webhook arrives after the succeeded one', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();

    expectAcknowledged(await webhook({ id: 'wh_1', paymentId, status: 'succeeded' }));
    expectAcknowledged(await webhook({ id: 'wh_2', paymentId, status: 'pending' }));
    expectAcknowledged(await webhook({ id: 'wh_3', paymentId, status: 'failed' }));

    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'paid' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });

  it('keeps a failed payment failed when a succeeded webhook arrives after it', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();

    expectAcknowledged(await webhook({ id: 'wh_1', paymentId, status: 'failed' }));
    expectAcknowledged(await webhook({ id: 'wh_2', paymentId, status: 'succeeded' }));

    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'failed' });
    expect((await balancesOf(groupId, ann.token)).find(b => b.memberId === bob.id)?.balance).toBe(-30);
  });

  it('counts a webhook that arrives long after the payment was decided as it would have on time', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();

    // The provider's `at` is when it sent the webhook; a day later, the status still moves the payment on, and only once.
    expectAcknowledged(await webhook({ id: 'wh_late', paymentId, status: 'succeeded', at: '2026-11-18T10:00:00Z' }));
    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'paid' });
  });

  it('is counted once when the same webhook reaches the server several times at the same moment, and every copy is acknowledged', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();

    const copies = await Promise.all([1, 2, 3].map(() => webhook({ id: 'wh_same', paymentId, status: 'succeeded' })));
    copies.forEach(expectAcknowledged);

    expect((await http.get(`/v1/settlements/${id}`, { token: bob.token })).body).toMatchObject({ status: 'paid' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });

  it('is acknowledged, with no change, when it says a status the settlement already had', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const paymentId = lastPayment();
    expectAcknowledged(await webhook({ id: 'wh_1', paymentId, status: 'succeeded' }));
    expectAcknowledged(await webhook({ id: 'wh_1', paymentId, status: 'succeeded' }));
    expect(await suggestedOf(groupId, ann.token)).toEqual([]);
  });
});

describe('a refund through the provider (request 15)', () => {
  it('refunds a paid payment asked by its payee, and the balances go back once the provider says it is refunded', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();
    expectAcknowledged(await webhook({ paymentId, status: 'succeeded' }));

    const refund = await refundSettlement(id, ann.token);
    expect(refund.status).toBe(201);
    expect(refunds).toEqual([{ path: `/payments/${paymentId}/refunds`, body: { reference: id } }]);

    // The money has not gone back yet: the settlement is refunding, and the balances still count it.
    expect(await readSettlement(id, bob.token)).toMatchObject({ status: 'refunding' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    expectAcknowledged(await webhook({ paymentId, status: 'refunded' }));
    expect(await readSettlement(id, bob.token)).toMatchObject({ status: 'refunded' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 30 },
      { memberId: bob.id, balance: -30 },
    ]);
    expect(await suggestedOf(groupId, ann.token)).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);

    // A refunded settlement is refunded once: a second refund is refused, and nothing is sent to the provider.
    expect((await refundSettlement(id, ann.token)).status).toBe(400);
    expect(refunds).toHaveLength(1);
  });

  it('is refused, and the provider is not asked, when the caller is not the payee, is not signed in, or is not a member', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    expectAcknowledged(await webhook({ paymentId: lastPayment(), status: 'succeeded' }));
    const stranger = await accountOf('cy.refund@example.com', 'Cy');

    expect((await refundSettlement(id, bob.token)).status).toBe(403);
    expect((await refundSettlement(id)).status).toBe(401);
    expect((await refundSettlement(id, stranger.token)).status).toBe(404);
    expect(refunds).toEqual([]);
    expect(await readSettlement(id, bob.token)).toMatchObject({ status: 'paid' });
  });

  it('is refused, with nothing sent to the provider, for a payment still waiting or a settlement in cash', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const waiting = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const waitingId = (waiting.body as { id: string }).id;

    const refusedWaiting = await refundSettlement(waitingId, ann.token);
    expect(refusedWaiting.status).toBe(400);
    expect(refusedWaiting.body).toEqual({ type: 'SettlementNotRefundable', message: expect.any(String) });

    // What is waiting at the provider counts as paid, so the cash settlement is made in a group where nothing waits.
    const other = await annAndBobOwing();
    const cash = await settleInCash(other.groupId, other.ann.token, { from: other.bob.id, amount: 30 });
    expect(cash.status).toBe(201);
    const refusedCash = await refundSettlement((cash.body as { id: string }).id, ann.token);
    expect(refusedCash.body).toEqual({ type: 'SettlementNotRefundable', message: expect.any(String) });
    expect(refunds).toEqual([]);
  });

  it('is refused once one of the two has left the group, so that the balances still add up to 0', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    expectAcknowledged(await webhook({ paymentId: lastPayment(), status: 'succeeded' }));
    expect((await http.request('POST', `/v1/groups/${groupId}/leave`, { token: bob.token })).status).toBe(201);

    const refused = await refundSettlement(id, ann.token);
    expect(refused.body).toEqual({ type: 'SettlementNotRefundable', message: expect.any(String) });
    expect(refunds).toEqual([]);
    expect(await balancesOf(groupId, ann.token)).toEqual([{ memberId: ann.id, balance: 0 }]);
  });

  it('is refused as the provider refused it, and nothing moves, when the provider does not accept the refund', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    expectAcknowledged(await webhook({ paymentId: lastPayment(), status: 'succeeded' }));
    refundAnswer = 'refuse';

    const refused = await refundSettlement(id, ann.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    expect(await readSettlement(id, bob.token)).toMatchObject({ status: 'paid' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });

  it('is refused when the provider does not answer the refund within 5 seconds, and nothing moves', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    expectAcknowledged(await webhook({ paymentId: lastPayment(), status: 'succeeded' }));
    refundAnswer = 'slow';

    const asking = await refundSettlement(id, ann.token);
    const operationId = (asking.body as { operationId?: string }).operationId;
    const refused = operationId ? await operationOutcome(operationId, ann.token) : asking;
    expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    expect(await readSettlement(id, bob.token)).toMatchObject({ status: 'paid' });
  }, 20000);

  it('counts a refunded webhook that overtakes the success of the same payment: refunded, and never counted', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    const id = (asked.body as { id: string }).id;
    const paymentId = lastPayment();

    expectAcknowledged(await webhook({ id: 'wh_refund_first', paymentId, status: 'refunded' }));
    expectAcknowledged(await webhook({ id: 'wh_success_late', paymentId, status: 'succeeded' }));

    expect(await readSettlement(id, bob.token)).toMatchObject({ status: 'refunded' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 30 },
      { memberId: bob.id, balance: -30 },
    ]);
  });
});

describe('Payout accounts (request 16)', () => {
  it('sets the account the provider knows, replaces it, and only its owner reads it', async () => {
    const ann = await accountOf('payout.ann@example.com', 'Ann');
    const bob = await accountOf('payout.bob@example.com', 'Bob');
    expect((await readPayoutAccount(ann.token)).status).toBe(404);

    expect((await setPayoutAccount(ann.token, 'acct_ann_1')).status).toBe(201);
    expect(accountsAsked).toEqual(['acct_ann_1']);
    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct_ann_1' });

    expect((await setPayoutAccount(ann.token, 'acct_ann_2')).status).toBe(201);
    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct_ann_2' });
    expect((await readPayoutAccount(bob.token)).status).toBe(404);
  });

  it('refuses an account the provider does not know, and one it does not answer about, and keeps the one held', async () => {
    const ann = await accountOf('payout.refusal@example.com', 'Ann');
    expect((await setPayoutAccount(ann.token, 'acct_ann_3')).status).toBe(201);

    const unknown = await setPayoutAccount(ann.token, 'acct_unknown');
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ type: 'UnknownPayoutAccount', message: expect.any(String) });

    accountAnswer = 'refuse';
    const refused = await setPayoutAccount(ann.token, 'acct_ann_4');
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });

    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct_ann_3' });
  });

  it('refuses a provider that does not answer within 5 seconds, and keeps the account held', async () => {
    const ann = await accountOf('payout.slow@example.com', 'Ann');
    expect((await setPayoutAccount(ann.token, 'acct_ann_5')).status).toBe(201);

    accountAnswer = 'slow';
    const late = await setPayoutAccount(ann.token, 'acct_ann_6');
    // The answer waits for the outcome only so long; the refusal is then read at the operation, as a slow payment's is.
    const outcome =
      late.status === 202
        ? await operationOutcome((late.body as { operationId: string }).operationId, ann.token)
        : { status: late.status, body: late.body };
    expect(outcome.status).toBe(400);
    expect(outcome.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct_ann_5' });
  }, 15000);

  it('is refused to a caller who is not signed in, and asks the provider nothing', async () => {
    expect((await setPayoutAccount(undefined, 'acct_anon')).status).toBe(401);
    expect((await readPayoutAccount()).status).toBe(401);
    expect(accountsAsked).toEqual([]);
  });

  it('refuses a payment to a payee with no payout account before the provider is asked, and keeps a cash settlement free of one', async () => {
    const ann = await accountOf('payout.nothing@example.com', 'Ann');
    const bob = await accountOf('payout.owing@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 40, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    expect(expense.status).toBe(201);

    const refused = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 20 });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'PayeeHasNoPayoutAccount', message: expect.any(String) });
    expect(requested).toEqual([]);

    expect((await settleInCash(groupId, ann.token, { from: bob.id, amount: 20 })).status).toBe(201);
  });

  it('pays through the payee account the provider is given, as it is set at the moment of the payment', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    expect((await setPayoutAccount(ann.token, 'acct_ann_7')).status).toBe(201);

    const asked = await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 });
    expect(asked.status).toBe(201);
    expect(requested).toEqual([
      { reference: (asked.body as { id: string }).id, amount: 30, currency: 'EUR', payee: 'acct_ann_7' },
    ]);
  });
});

const listSettlements = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/settlements`, { token });

describe('a group’s settlements, and each one’s history (request 19)', () => {
  it('lists the settlements the most recent first, each with every status it has had, the earliest first', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();

    // First: 10 through the provider, paid, then refunded by its payee: pending, paid, refunding, refunded.
    const first = (await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 10 })).body as { id: string };
    const firstPayment = lastPayment();
    expectAcknowledged(await webhook({ paymentId: firstPayment, status: 'succeeded' }));
    expect((await refundSettlement(first.id, ann.token)).status).toBe(201);
    expectAcknowledged(await webhook({ paymentId: firstPayment, status: 'refunded' }));

    // Second: 30 through the provider, failed: pending, failed. It frees what it held, so the third may be asked for the same 30.
    const second = (await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 })).body as { id: string };
    const secondPayment = lastPayment();
    expectAcknowledged(await webhook({ paymentId: secondPayment, status: 'failed' }));

    // Third: 30 through the provider, paid: pending, paid.
    const third = (await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 30 })).body as { id: string };
    expectAcknowledged(await webhook({ paymentId: lastPayment(), status: 'succeeded' }));

    const listed = await listSettlements(groupId, bob.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        id: third.id,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 30,
        method: 'provider',
        status: 'paid',
        at: expect.any(String),
        payUrl: expect.any(String),
        history: [
          { status: 'pending', at: expect.any(String) },
          { status: 'paid', at: expect.any(String) },
        ],
      },
      {
        id: second.id,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 30,
        method: 'provider',
        status: 'failed',
        at: expect.any(String),
        payUrl: expect.any(String),
        history: [
          { status: 'pending', at: expect.any(String) },
          { status: 'failed', at: expect.any(String) },
        ],
      },
      {
        id: first.id,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 10,
        method: 'provider',
        status: 'refunded',
        at: expect.any(String),
        payUrl: expect.any(String),
        history: [
          { status: 'pending', at: expect.any(String) },
          { status: 'paid', at: expect.any(String) },
          { status: 'refunding', at: expect.any(String) },
          { status: 'refunded', at: expect.any(String) },
        ],
      },
    ]);

    // The settlement read by its id carries the same history.
    expect((await http.get(`/v1/settlements/${first.id}`, { token: ann.token })).body).toMatchObject({
      history: [{ status: 'pending' }, { status: 'paid' }, { status: 'refunding' }, { status: 'refunded' }],
    });
  });

  it('adds nothing for a webhook that changes nothing, and only the status it moves to when it moves past one never had', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = (await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 10 })).body as { id: string };
    const paymentId = lastPayment();

    expectAcknowledged(await webhook({ paymentId, status: 'pending' }));
    expectAcknowledged(await webhook({ paymentId, status: 'authorised' }));
    expect(await readHistory(asked.id, bob.token)).toEqual(['pending']);

    // Refunded arrives for a payment that never succeeded in Tally: the line is refunded alone, no `paid` is invented.
    expectAcknowledged(await webhook({ paymentId, status: 'refunded' }));
    expect(await readHistory(asked.id, bob.token)).toEqual(['pending', 'refunded']);

    // Once refunded, a later success changes nothing: the history is as it was.
    expectAcknowledged(await webhook({ paymentId, status: 'succeeded' }));
    expect(await readHistory(asked.id, bob.token)).toEqual(['pending', 'refunded']);
  });

  it('dates each status by when Tally learned it, not by the provider’s word', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const asked = (await payThroughProvider(groupId, bob.token, { to: ann.id, amount: 10 })).body as { id: string };
    const paymentId = lastPayment();
    const requested = (await http.get(`/v1/settlements/${asked.id}`, { token: bob.token })).body as { at: string };

    // The provider says it happened in 2020, long before Tally recorded the payment: the history does not take that time, so the
    // line is no earlier than the settlement's own time, which is the clock's at the request.
    expectAcknowledged(await webhook({ paymentId, status: 'succeeded', at: '2020-01-01T10:00:00Z' }));

    const read = (await http.get(`/v1/settlements/${asked.id}`, { token: bob.token })).body as {
      history: { status: string; at: string }[];
    };
    expect(read.history[1]).toEqual({ status: 'paid', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(Date.parse(read.history[1].at)).toBeGreaterThanOrEqual(Date.parse(requested.at));
  });

  it('lists a cash settlement with its one line, and keeps it listed after its payer has left, to the members still in the group', async () => {
    const { ann, bob, groupId } = await annAndBobOwing();
    const carl = await accountOf('carl.history@example.com', 'Carl');

    const cash = (await settleInCash(groupId, ann.token, { from: bob.id, amount: 30 })).body as { id: string };
    expect(await readHistory(cash.id, ann.token)).toEqual(['paid']);

    // Bob's balance is 0, so he may leave; his settlement stays the group's.
    expect(
      (await http.request('POST', `/v1/groups/${groupId}/leave`, { token: bob.token })).status,
    ).toBeGreaterThanOrEqual(200);

    const afterLeaving = await listSettlements(groupId, ann.token);
    expect(afterLeaving.status).toBe(200);
    expect(afterLeaving.body).toEqual([
      {
        id: cash.id,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 30,
        method: 'cash',
        status: 'paid',
        at: expect.any(String),
        history: [{ status: 'paid', at: expect.any(String) }],
      },
    ]);

    // Bob, who has left, is no longer a member and sees the group no more; Carl never was, and sees nothing either.
    expect((await listSettlements(groupId, bob.token)).status).toBe(404);
    expect((await listSettlements(groupId, carl.token)).status).toBe(404);
    expect((await listSettlements(groupId)).status).toBe(401);
  });
});

/** The statuses a settlement has had, in the order it had them, as its read by its id gives them. */
async function readHistory(settlementId: string, token: string): Promise<string[]> {
  const read = (await http.get(`/v1/settlements/${settlementId}`, { token })).body as {
    history: { status: string }[];
  };
  return read.history.map(line => line.status);
}
