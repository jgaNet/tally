import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'fee-policy-test-secret';
const DAY = '2026-02-10';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
/** Every payment the provider was asked for, in order. */
const issued: Array<{ paymentId: string; reference: string; amount: number }> = [];
/** The fee the provider gives for each payment it is asked for, read when the payment is asked; `null` answers no fee at all. */
let feeGiven: number | null = 3;
let previousEnv: { url?: string; secret?: string };

beforeAll(async () => {
  // A stand-in for the provider: it answers a payment link with its fee, the way its API says (request 38).
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      // A payout account the provider knows, asked for when it is set (request 16).
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: decodeURIComponent(request.url?.split('/').pop() ?? '') }));
        return;
      }
      const body = JSON.parse(text) as { reference: string; amount: number };
      const paymentId = `pay_${issued.length + 1}`;
      issued.push({ paymentId, ...body });
      response.writeHead(201, { 'content-type': 'application/json' });
      const answer: Record<string, unknown> = { id: paymentId, payUrl: `https://pay.example/${paymentId}` };
      if (feeGiven !== null) answer.fee = feeGiven;
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  previousEnv = { url: process.env.PROVIDER_URL, secret: process.env.PROVIDER_WEBHOOK_SECRET };
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
  restoreEnv('PROVIDER_URL', previousEnv.url);
  restoreEnv('PROVIDER_WEBHOOK_SECRET', previousEnv.secret);
});

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Sends a command and follows the operation it was answered with. */
async function command(method: string, path: string, token: string | undefined, body?: object): Promise<Operation> {
  const answer = await http.request(method, path, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Signs someone up and in, with a payout account at the provider, so that they can be paid through it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  const person = { id: operation.result as string, token: (login.body as { token: string }).token };
  const payout = await command('PUT', `${api}/accounts/me/payout-account`, person.token, {
    accountId: `payout_${person.id}`,
  });
  expect(payout).toMatchObject({ status: 'SUCCESS' });
  return person;
}

/** A group of two, Ann the owner and Bob, where Ann paid a dinner of 60 they share: Bob owes Ann 30. */
async function dinnerGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${prefix}-bob@example.com`, 'Bob');
  const created = await command('POST', `${api}/groups`, ann.token, { name: 'Fees', currency: 'EUR' });
  const groupId = created.result as string;
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: bob.token });
  await outcome((accepted.body as { operationId: string }).operationId, bob.token);
  expect(
    await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: DAY,
      splitBetween: [ann.id, bob.id],
    }),
  ).toMatchObject({ status: 'SUCCESS' });
  return { ann, bob, groupId };
}

/** The provider's webhook, signed over the body as sent, and followed to its end. */
async function webhook(body: { id: string; paymentId: string; status: string; at: string }): Promise<Operation> {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  const answer = await http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signature },
  });
  return outcome((answer.body as { operationId: string }).operationId);
}

describe('who bears the provider fee (request 38)', () => {
  it('is the payee until the owner says otherwise, and a member reads it', async () => {
    const { bob, groupId } = await dinnerGroup('default');
    const read = await http.get(`${api}/groups/${groupId}/fee-policy`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ borneBy: 'payee' });
  });

  it('is refused to someone outside the group, who is told the group does not exist', async () => {
    const { groupId } = await dinnerGroup('outside');
    const stranger = await signedIn('outside-stranger@example.com', 'Stranger');
    const read = await http.get(`${api}/groups/${groupId}/fee-policy`, { token: stranger.token });
    expect(read.status).toBe(404);
  });

  it('is changed by the owner only: another member is refused', async () => {
    const { bob, groupId } = await dinnerGroup('member');
    const refused = await command('PUT', `${api}/groups/${groupId}/fee-policy`, bob.token, { borneBy: 'payer' });
    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'OnlyTheOwnerMayChangeFeePolicy' } });
  });

  it('is refused when it is not one of the three', async () => {
    const { ann, groupId } = await dinnerGroup('invalid');
    const refused = await command('PUT', `${api}/groups/${groupId}/fee-policy`, ann.token, { borneBy: 'everyone' });
    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'InvalidFeePolicy' } });
  });

  it('is set by the owner, and a payment asked for from then on settles the amount less the payer part', async () => {
    const { ann, bob, groupId } = await dinnerGroup('payer');
    expect(await command('PUT', `${api}/groups/${groupId}/fee-policy`, ann.token, { borneBy: 'payer' })).toMatchObject({
      status: 'SUCCESS',
    });
    const read = await http.get(`${api}/groups/${groupId}/fee-policy`, { token: ann.token });
    expect(read.body).toEqual({ borneBy: 'payer' });

    const paid = await command('POST', `${api}/groups/${groupId}/settlements/provider`, bob.token, {
      to: ann.id,
      amount: 30,
    });
    expect(paid).toMatchObject({ status: 'SUCCESS' });
    const settlementId = paid.result as string;
    const payment = issued[issued.length - 1];

    const pending = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect(pending.body).toMatchObject({ amount: 30, status: 'pending', fee: { amount: 3, borneBy: 'payer' } });

    expect(
      await webhook({ id: 'wh_1', paymentId: payment.paymentId, status: 'succeeded', at: '2026-02-11T10:00:00.000Z' }),
    ).toMatchObject({ status: 'SUCCESS' });

    // Bob bore the fee: the settlement settles 27, and Bob still owes the 3 of the fee.
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token });
    expect(balances.body).toEqual([
      { memberId: ann.id, balance: 3 },
      { memberId: bob.id, balance: -3 },
    ]);
  });

  it('is refused for a payment when the provider gives no fee, and nothing is kept', async () => {
    const { ann, bob, groupId } = await dinnerGroup('nofee');
    feeGiven = null;
    try {
      const refused = await command('POST', `${api}/groups/${groupId}/settlements/provider`, bob.token, {
        to: ann.id,
        amount: 30,
      });
      expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'ProviderUnavailable' } });
    } finally {
      feeGiven = 3;
    }
  });
});
