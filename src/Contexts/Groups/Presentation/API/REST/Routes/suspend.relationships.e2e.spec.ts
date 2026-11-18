import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * The relationships request 34 crosses, each proved through the API: an account made in one context keeps the id its request answered, and
 * the other context refuses or records by that same id. Groups → Ledger and Groups → Settlements carry the suspension to the other contexts;
 * Settlements → Groups carries a decision made in Settlements into the administrators' log Groups answers.
 */

const SECRET = 'suspend-relationships-secret';
const ADMIN = 'suspend-rel-boss@example.com';
const DAY = '2026-02-10';
const WEBHOOK_AT = '2026-02-11T10:00:00.000Z';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
const issued: Array<{ paymentId: string }> = [];
let previousEnv: { url?: string; secret?: string; admins?: string };

beforeAll(async () => {
  // A stand-in for the provider: every payout account is known, and each payment is answered with its link.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
        return;
      }
      const paymentId = `pay_${issued.length + 1}`;
      issued.push({ paymentId });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: paymentId, payUrl: `https://pay.example/${paymentId}` }));
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
  process.env.ADMIN_EMAILS = ADMIN;

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

async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

async function command(method: string, path: string, token: string | undefined, body?: object): Promise<Operation> {
  const answer = await http.request(method, path, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Signs someone up and in, with a payout account at the provider, so that they can be paid through it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  // A second sign-up of the same email is refused, so the id is read from the account the sign-in names.
  await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  const token = (login.body as { token: string }).token;
  const person = { id: ((await http.get(`${api}/accounts/me`, { token })).body as { id: string }).id, token };
  expect(
    await command('PUT', `${api}/accounts/me/payout-account`, person.token, { accountId: `payout_${person.id}` }),
  ).toMatchObject({ status: 'SUCCESS' });
  return person;
}

/** A group of Ann and Bob, where Ann paid a dinner Bob shares: Bob owes Ann 30. */
async function dinnerGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${prefix}-bob@example.com`, 'Bob');
  const created = await command('POST', `${api}/groups`, ann.token, { name: 'Suspended', currency: 'EUR' });
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

const suspension = (accountId: string) => `${api}/admin/accounts/${accountId}/suspension`;

describe('the relationships request 34 crosses', () => {
  it('writes nothing in a group when an account is suspended or reinstated, and logs each to the administrators', async () => {
    const { ann, bob, groupId } = await dinnerGroup('rel-state');
    const boss = await signedIn(ADMIN, 'Boss');
    expect(await command('PUT', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });
    expect(await command('DELETE', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });
    const log = await http.get(`${api}/admin/log`, { token: boss.token });
    expect(
      (log.body as { action: string; subjectId: string }[])
        .filter(entry => entry.subjectId === bob.id)
        .map(e => e.action),
    ).toEqual(['suspended', 'reinstated']);
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token });
    expect(balances.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: bob.id, balance: -30 })]),
    );
  });

  it('Groups → Ledger: an account signed up in Groups, suspended by its id, is refused an expense in Ledger under that id', async () => {
    const { bob, groupId } = await dinnerGroup('rel-ledger');
    const boss = await signedIn(ADMIN, 'Boss');
    expect(await command('PUT', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });

    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, bob.token, {
        description: 'Taxi',
        amount: 40,
        date: DAY,
        splitBetween: [bob.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountSuspended' } });
  });

  it('Groups → Settlements: an account signed up in Groups, suspended by its id, is refused a settlement in Settlements under that id', async () => {
    const { ann, bob, groupId } = await dinnerGroup('rel-settlements');
    const boss = await signedIn(ADMIN, 'Boss');
    expect(await command('PUT', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });

    expect(
      await command('POST', `${api}/groups/${groupId}/settlements/cash`, bob.token, { from: ann.id, amount: 30 }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountSuspended' } });
  });

  it("Settlements → Groups: a settlement contested and decided in Settlements is in the administrators' log Groups answers, under the settlement's id", async () => {
    const { ann, bob, groupId } = await dinnerGroup('rel-log');
    const boss = await signedIn(ADMIN, 'Boss');
    const paid = await command('POST', `${api}/groups/${groupId}/settlements/provider`, bob.token, {
      to: ann.id,
      amount: 30,
    });
    expect(paid).toMatchObject({ status: 'SUCCESS' });
    const settlementId = paid.result as string;
    const payment = issued[issued.length - 1];
    const body = { id: `evt_${payment.paymentId}`, paymentId: payment.paymentId, status: 'succeeded', at: WEBHOOK_AT };
    const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
    const webhookAnswer = await http.request('POST', `${api}/provider/webhooks`, {
      body,
      headers: { 'provider-signature': signature },
    });
    expect(await outcome((webhookAnswer.body as { operationId: string }).operationId)).toMatchObject({
      status: 'SUCCESS',
    });

    expect(await command('POST', `${api}/settlements/${settlementId}/contest`, ann.token)).toMatchObject({
      status: 'SUCCESS',
    });
    expect(
      await command('POST', `${api}/admin/settlements/${settlementId}/decision`, boss.token, { paid: false }),
    ).toMatchObject({ status: 'SUCCESS' });

    const log = await http.get(`${api}/admin/log`, { token: boss.token });
    expect(log.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'decided-annulled', by: boss.id, subjectId: settlementId }),
      ]),
    );
  });
});
