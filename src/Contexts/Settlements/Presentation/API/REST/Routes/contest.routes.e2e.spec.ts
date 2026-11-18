import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'contest-test-secret';
const ADMIN = 'boss@example.com';
const DAY = '2026-02-10';
/** When the provider's webhooks say a payment changed: a fixed instant, as the tests' clock. */
const WEBHOOK_AT = '2026-02-11T10:00:00.000Z';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
/** Every payment link the provider gave, in the order it gave them. */
const issued: Array<{ paymentId: string; reference: string; amount: number; currency: string; payee: string }> = [];
let previousEnv: { url?: string; secret?: string; admins?: string };

beforeAll(async () => {
  // A stand-in for the provider: it knows every payout account, and answers each payment with its link.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
        return;
      }
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string; payee: string };
      const paymentId = `pay_${issued.length + 1}`;
      issued.push({ paymentId, ...body });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: paymentId, fee: 0, payUrl: `https://pay.example/${paymentId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  previousEnv = {
    url: process.env.PROVIDER_URL,
    secret: process.env.PROVIDER_WEBHOOK_SECRET,
    admins: process.env.ADMIN_EMAILS,
  };
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ` ${ADMIN.toUpperCase()}, someone-else@example.com `;

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
  restoreEnv('ADMIN_EMAILS', previousEnv.admins);
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

/** A group of two members, Ann and Bob, where Ann paid a dinner Bob shares: Bob owes Ann 30. */
async function dinnerGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${prefix}-bob@example.com`, 'Bob');
  const created = await command('POST', `${api}/groups`, ann.token, { name: 'Contest', currency: 'EUR' });
  const groupId = created.result as string;
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: bob.token });
  await outcome((accepted.body as { operationId: string }).operationId, bob.token);
  await expenseBetween(ann, groupId, bob.id, 'Dinner');
  return { ann, bob, groupId };
}

async function expenseBetween(
  payer: { id: string; token: string },
  groupId: string,
  other: string,
  description: string,
) {
  expect(
    await command('POST', `${api}/groups/${groupId}/expenses`, payer.token, {
      description,
      amount: 60,
      date: DAY,
      splitBetween: [payer.id, other],
    }),
  ).toMatchObject({ status: 'SUCCESS' });
}

/** The provider's webhook, signed over the body as sent, and followed to its end. */
async function webhook(body: { id: string; paymentId: string; status: string; at: string }): Promise<Operation> {
  const text = JSON.stringify(body);
  const signature = createHmac('sha256', SECRET).update(text).digest('hex');
  const answer = await http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signature },
  });
  return outcome((answer.body as { operationId: string }).operationId);
}

/** Bob pays Ann through the provider, and the provider says it succeeded: the settlement is paid. */
async function paidThroughProvider(payer: { token: string }, groupId: string, payee: string): Promise<string> {
  const paid = await command('POST', `${api}/groups/${groupId}/settlements/provider`, payer.token, {
    to: payee,
    amount: 30,
  });
  expect(paid).toMatchObject({ status: 'SUCCESS' });
  const settlementId = paid.result as string;
  const payment = issued[issued.length - 1] as (typeof issued)[number];
  expect(
    await webhook({
      id: `evt_${payment.paymentId}`,
      paymentId: payment.paymentId,
      status: 'succeeded',
      at: WEBHOOK_AT,
    }),
  ).toMatchObject({ status: 'SUCCESS' });
  return settlementId;
}

async function balances(token: string, groupId: string): Promise<Record<string, number>> {
  const answer = await http.get(`${api}/groups/${groupId}/balances`, { token });
  expect(answer.status).toBe(200);
  return Object.fromEntries(
    (answer.body as Array<{ memberId: string; balance: number }>).map(b => [b.memberId, b.balance]),
  );
}

describe('contest a settlement (request 33)', () => {
  it('holds a contested settlement until an administrator decides it was paid, and keeps both in the audit and the log', async () => {
    const { ann, bob, groupId } = await dinnerGroup('ct1');
    const boss = await signedIn(ADMIN, 'Boss');
    const settlementId = await paidThroughProvider(bob, groupId, ann.id);
    expect(await balances(ann.token, groupId)).toEqual({ [ann.id]: 0, [bob.id]: 0 });

    // Only the payee contests, and only once.
    expect(await command('POST', `${api}/settlements/${settlementId}/contest`, bob.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'OnlyThePayeeMayContest' },
    });
    expect(await command('POST', `${api}/settlements/${settlementId}/contest`, ann.token)).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      status: 200,
      body: {
        status: 'contested',
        history: expect.arrayContaining([expect.objectContaining({ status: 'contested' })]),
      },
    });
    expect(await command('POST', `${api}/settlements/${settlementId}/contest`, ann.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'SettlementAlreadyContested' },
    });

    // Held: the balances are as they were before it was paid, and what Bob owes is still counted as paid for the suggestions.
    expect(await balances(ann.token, groupId)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
    expect(await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: ann.token })).toMatchObject({
      status: 200,
      body: [],
    });

    // A webhook about the contested payment changes nothing.
    const payment = issued[issued.length - 1] as (typeof issued)[number];
    expect(
      await webhook({
        id: `evt_again_${payment.paymentId}`,
        paymentId: payment.paymentId,
        status: 'succeeded',
        at: WEBHOOK_AT,
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { status: 'contested' },
    });

    // Administrators only: nobody signed in is asked to sign in, a member does not see the contests.
    expect((await http.get(`${api}/admin/contests`)).status).toBe(401);
    expect((await http.get(`${api}/admin/contests`, { token: ann.token })).status).toBe(404);
    expect(await http.get(`${api}/admin/contests`, { token: boss.token })).toMatchObject({
      status: 200,
      body: [expect.objectContaining({ id: settlementId, status: 'contested' })],
    });
    expect(
      await command('POST', `${api}/admin/settlements/${settlementId}/decision`, ann.token, { paid: true }),
    ).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotAllowed' },
    });

    // The administrator decides it was paid: it counts again, as it did before.
    expect(
      await command('POST', `${api}/admin/settlements/${settlementId}/decision`, boss.token, { paid: true }),
    ).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { status: 'paid' },
    });
    expect(await balances(ann.token, groupId)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
    expect(await http.get(`${api}/admin/contests`, { token: boss.token })).toMatchObject({ body: [] });

    const audit = await http.get(`${api}/groups/${groupId}/audit`, { token: ann.token });
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-contested', by: ann.id, subjectId: settlementId, amount: 30 }),
        expect.objectContaining({ action: 'settlement-paid', by: boss.id, subjectId: settlementId, amount: 30 }),
      ]),
    );

    const log = await http.get(`${api}/admin/log`, { token: boss.token });
    expect(log).toMatchObject({
      status: 200,
      body: [expect.objectContaining({ action: 'decided-paid', by: boss.id, subjectId: settlementId })],
    });
    expect((await http.get(`${api}/admin/log`, { token: ann.token })).status).toBe(404);
    expect((await http.get(`${api}/admin/log`)).status).toBe(401);
  });

  it('annuls a contested settlement the administrator decides was not paid, and what was owed is owed again', async () => {
    const { ann, bob, groupId } = await dinnerGroup('ct2');
    const boss = await signedIn(ADMIN, 'Boss');
    const settlementId = await paidThroughProvider(bob, groupId, ann.id);
    expect(await command('POST', `${api}/settlements/${settlementId}/contest`, ann.token)).toMatchObject({
      status: 'SUCCESS',
    });

    expect(
      await command('POST', `${api}/admin/settlements/${settlementId}/decision`, boss.token, { paid: false }),
    ).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { status: 'annulled' },
    });
    expect(await balances(ann.token, groupId)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
    expect(await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: ann.token })).toMatchObject({
      status: 200,
      body: [{ from: bob.id, to: ann.id, amount: 30 }],
    });
    // A decided settlement is decided once.
    expect(
      await command('POST', `${api}/admin/settlements/${settlementId}/decision`, boss.token, { paid: true }),
    ).toMatchObject({
      status: 'ERROR',
      error: { type: 'OnlyAContestedSettlementIsDecided' },
    });
    expect(await http.get(`${api}/admin/log`, { token: boss.token })).toMatchObject({
      body: expect.arrayContaining([expect.objectContaining({ action: 'decided-annulled', subjectId: settlementId })]),
    });
  });
});
