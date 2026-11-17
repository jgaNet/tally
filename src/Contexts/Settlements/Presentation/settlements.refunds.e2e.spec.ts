import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A refund of a settlement paid through the provider, over HTTP, against a database file and a fake provider on a local port (request 15,
 * fragment 15): the payee refunds it whole, and it is refunding, still counted, until the provider's webhook says it is refunded, and then
 * the balances go back; refusals with nothing changed (the payer or another member, a settlement in cash, one not paid, one whose payer
 * or payee has left, a provider that does not accept the refund); and the webhooks, which move a payment forward only (request 14).
 */
let directory: string;
let provider: Server;
let providerUrl: string;
/** How the fake provider answers a refund: accepted, refused, or not at all (Tally gives up after 5 seconds). */
let refundMode: 'ok' | 'down' | 'hang';
/** The payments the provider keeps, by the reference Tally gave them (the settlement's id). */
let paymentsByReference: Map<string, string>;
/** The refunds Tally asked the provider for: the payment's id, and the settlement's id as the reference. */
let providerRefunds: { paymentId: string; reference: string }[];
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let webhooks: number;

const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-refunds-settlements-'));
  const databasePath = join(directory, 'tally.sqlite');

  nextPayment = 0;
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A payout account the provider knows is `acct-…` (request 16): `GET /accounts/{id}` answers its id, and nothing else is known.
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      const known = decodeURIComponent(account[1]).startsWith('acct-');
      res.statusCode = known ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(known ? JSON.stringify({ id: decodeURIComponent(account[1]) }) : '{}');
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text || '{}') as { reference?: string; amount?: number; currency?: string };
      const refund = /^\/payments\/([^/]+)\/refunds$/.exec(req.url ?? '');
      if (refund) {
        providerRefunds.push({ paymentId: decodeURIComponent(refund[1]), reference: body.reference as string });
        if (refundMode === 'hang') return;
        if (refundMode === 'down') {
          res.statusCode = 503;
          res.end('unavailable');
          return;
        }
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `refund-${providerRefunds.length}` }));
        return;
      }
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference as string, id);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({ databasePath, logger: silent, providerUrl, providerWebhookSecret: SECRET });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
  eve = await person('Eve', 'eve@example.com');
});

beforeEach(() => {
  refundMode = 'ok';
  paymentsByReference = new Map();
  providerRefunds = [];
  webhooks = 0;
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  // Every person has a payout account at the provider, so that a payment to them can be asked (request 16).
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    token,
    body: { accountId: `acct-${name.toLowerCase()}` },
  });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let cy: Awaited<ReturnType<typeof person>>;
let eve: Awaited<ReturnType<typeof person>>;

const createGroup = async () => {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  return (body as { id: string }).id;
};

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const payThroughProvider = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { token, body });
const recordCash = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { token, body });
const refund = (token: string, id: string) => http.request('POST', `${api}/settlements/${id}/refund`, { token });
const read = (token: string, id: string) => http.request('GET', `${api}/settlements/${id}`, { token });
const balances = (groupId: string) => http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });

/** The provider's signature of a webhook body, as the provider makes it: HMAC-SHA256 of the body as sent, in lowercase hex. */
const signatureOf = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

/** The provider sends a webhook about a payment, signed over its body as sent. */
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh-${(webhooks += 1)}`, paymentId, status, at: WEBHOOK_AT };
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signatureOf(body) },
  });
};

const paymentOf = (settlementId: string) => paymentsByReference.get(settlementId) as string;

/** A group of Ann, Bob and Cy in which Ann paid 3000 for all three, split equally: Bob and Cy each owe 1000 to Ann. */
const threeOwing = async () => {
  const groupId = await createGroup();
  await joinGroup(groupId, bob);
  await joinGroup(groupId, cy);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 3000,
    date: PAST_DAY,
    splitBetween: [ann.id, bob.id, cy.id],
  });
  return groupId;
};

const balancesOf = (annsBalance: number, bobsBalance: number, cysBalance: number) => [
  { memberId: ann.id, balance: annsBalance },
  { memberId: bob.id, balance: bobsBalance },
  { memberId: cy.id, balance: cysBalance },
];
const atStart = () => balancesOf(2000, -1000, -1000);
/** The balances once Bob's 1000 to Ann is counted as paid. */
const afterBobPaid = () => balancesOf(1000, 0, -1000);

/** Bob asks to pay Ann 1000 through the provider: the settlement's id, and the provider's payment of it. */
const bobPaysAnn = async (groupId: string) => {
  const { body } = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
  const id = (body as { id: string }).id;
  return { id, payment: paymentOf(id) };
};

/** A settlement of Bob's to Ann through the provider, which the provider says succeeded: paid and counted. */
const paidBobToAnn = async (groupId: string) => {
  const settlement = await bobPaysAnn(groupId);
  expect((await webhook(settlement.payment, 'succeeded')).status).toBe(204);
  return settlement;
};

describe('a refund asked by the payee of a settlement paid through the provider', () => {
  it('is refunding, still counted, until the provider says it is refunded; then the balances go back', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await paidBobToAnn(groupId);
    expect((await balances(groupId)).body).toEqual(afterBobPaid());

    const answered = await refund(ann.token, id);

    expect(answered.status).toBe(204);
    expect(providerRefunds).toEqual([{ paymentId: payment, reference: id }]);
    expect((await read(ann.token, id)).body).toMatchObject({ id, status: 'refunding', method: 'provider' });
    expect((await balances(groupId)).body).toEqual(afterBobPaid());

    expect((await webhook(payment, 'refunded')).status).toBe(204);

    expect((await read(ann.token, id)).body).toMatchObject({ id, status: 'refunded' });
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('is refused for the payer, or any other member, with nothing asked of the provider', async () => {
    const groupId = await threeOwing();
    const { id } = await paidBobToAnn(groupId);

    const byPayer = await refund(bob.token, id);
    const byOther = await refund(cy.token, id);

    expect(byPayer.status).toBe(403);
    expect(byPayer.body).toMatchObject({ type: 'NotAllowed' });
    expect(byOther.status).toBe(403);
    expect(providerRefunds).toEqual([]);
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'paid' });
  });

  it('is refused to someone outside the group as a settlement that does not exist for them', async () => {
    const groupId = await threeOwing();
    const { id } = await paidBobToAnn(groupId);

    const answered = await refund(eve.token, id);

    expect(answered.status).toBe(404);
    expect(providerRefunds).toEqual([]);
  });

  it('is refused for a settlement in cash, and for one that is not paid yet', async () => {
    const groupId = await threeOwing();
    const cashSettlement = await recordCash(ann.token, groupId, { from: bob.id, amount: 400 });
    const { body } = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 600 });
    const pending = { id: (body as { id: string }).id };

    const inCash = await refund(ann.token, (cashSettlement.body as { id: string }).id);
    const notPaid = await refund(ann.token, pending.id);

    expect(inCash.status).toBe(422);
    expect(inCash.body).toMatchObject({ type: 'SettlementNotRefundable' });
    expect(notPaid.status).toBe(422);
    expect(notPaid.body).toMatchObject({ type: 'SettlementNotRefundable' });
    expect(providerRefunds).toEqual([]);
    expect((await read(ann.token, pending.id)).body).toMatchObject({ status: 'pending' });
  });

  it('is refused once it is refunding: a refund is asked once', async () => {
    const groupId = await threeOwing();
    const { id } = await paidBobToAnn(groupId);
    expect((await refund(ann.token, id)).status).toBe(204);

    const again = await refund(ann.token, id);

    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ type: 'SettlementNotRefundable' });
    expect(providerRefunds).toHaveLength(1);
  });

  it('is refused, and nothing changes, when the provider does not answer the refund', async () => {
    const groupId = await threeOwing();
    const { id } = await paidBobToAnn(groupId);

    refundMode = 'down';
    const refused = await refund(ann.token, id);

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'RefundUnavailable' });
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'paid' });
    expect((await balances(groupId)).body).toEqual(afterBobPaid());

    refundMode = 'ok';
    expect((await refund(ann.token, id)).status).toBe(204);
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'refunding' });
  });

  it('is refused, and nothing changes, when the provider does not answer within 5 seconds', async () => {
    const groupId = await threeOwing();
    const { id } = await paidBobToAnn(groupId);

    refundMode = 'hang';
    const refused = await refund(ann.token, id);

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'RefundUnavailable' });
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'paid' });
  }, 15000);

  it('is refused when its payer has left the group, so that the balances still add up to 0', async () => {
    const groupId = await threeOwing();
    const { id } = await paidBobToAnn(groupId);
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBe(204);

    const answered = await refund(ann.token, id);

    expect(answered.status).toBe(422);
    expect(answered.body).toMatchObject({ type: 'RefundPartyLeft' });
    expect(providerRefunds).toEqual([]);
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'paid' });
  });
});

describe("the provider's refunded webhook, in order", () => {
  it('a refund that overtakes the success of its payment leaves it refunded and never counted; a late success changes nothing', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await bobPaysAnn(groupId);

    expect((await webhook(payment, 'refunded')).status).toBe(204);
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'refunded' });
    expect((await balances(groupId)).body).toEqual(atStart());

    expect((await webhook(payment, 'succeeded')).status).toBe(204);
    expect((await read(ann.token, id)).body).toMatchObject({ status: 'refunded' });
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('a refunded said twice counts once', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await paidBobToAnn(groupId);

    expect((await webhook(payment, 'refunded')).status).toBe(204);
    expect((await webhook(payment, 'refunded')).status).toBe(204);

    expect((await read(ann.token, id)).body).toMatchObject({ status: 'refunded' });
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('a refund the provider makes of a paid payment, without Tally asking, is refunded too', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await paidBobToAnn(groupId);

    expect((await webhook(payment, 'refunded')).status).toBe(204);

    expect((await read(ann.token, id)).body).toMatchObject({ status: 'refunded' });
    expect((await balances(groupId)).body).toEqual(atStart());
    expect((await refund(ann.token, id)).status).toBe(422);
  });
});
