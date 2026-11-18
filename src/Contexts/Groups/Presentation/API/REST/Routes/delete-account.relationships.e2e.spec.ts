import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * The relationships request 35 crosses, each proved through the API: an account made in Groups keeps the id its request answered, and the
 * other contexts read and refuse by that same id once it is deleted; what Ledger and Settlements made is found in Groups by its id.
 */

const SECRET = 'delete-relationships-secret';
const ADMIN = 'delete-rel-boss@example.com';
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

/** A group of Ann and Cy, where Ann paid a dinner Cy shares: Cy owes Ann 30. */
async function dinnerGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const cy = await signedIn(`${prefix}-cy@example.com`, 'Cy');
  const created = await command('POST', `${api}/groups`, ann.token, { name: 'Deleted', currency: 'EUR' });
  const groupId = created.result as string;
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: cy.token });
  await outcome((accepted.body as { operationId: string }).operationId, cy.token);
  expect(
    await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: DAY,
      splitBetween: [ann.id, cy.id],
    }),
  ).toMatchObject({ status: 'SUCCESS' });
  return { ann, cy, groupId };
}

const deleteMe = (token: string) => command('DELETE', `${api}/accounts/me`, token);

describe('the relationships request 35 crosses', () => {
  it('Groups → Ledger: an account signed up in Groups, deleted by its id, stays in Ledger under that id with its balance, and is in no new split', async () => {
    const { ann, cy, groupId } = await dinnerGroup('rel-ledger');
    expect(await deleteMe(cy.token)).toMatchObject({ status: 'SUCCESS' });

    const balances = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances).toEqual(expect.arrayContaining([{ memberId: cy.id, balance: -30 }]));
    expect(balances.reduce((sum, entry) => sum + entry.balance, 0)).toBe(0);
    const statement = await http.get(`${api}/groups/${groupId}/members/${cy.id}/statement`, { token: ann.token });
    expect(statement.body).toMatchObject({ memberId: cy.id, balance: -30 });
    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
        description: 'Taxi',
        amount: 40,
        date: DAY,
        splitBetween: [ann.id, cy.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountDeleted' } });
  });

  it('Groups → Settlements: an account signed up in Groups, deleted by its id, is refused a payment through the provider in Settlements, while the cash it owes is still recorded', async () => {
    const { ann, cy, groupId } = await dinnerGroup('rel-settlements');
    expect(await deleteMe(cy.token)).toMatchObject({ status: 'SUCCESS' });

    expect(
      await command('POST', `${api}/groups/${groupId}/settlements/provider`, ann.token, { to: cy.id, amount: 5 }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountDeleted' } });
    const cash = await command('POST', `${api}/groups/${groupId}/settlements/cash`, ann.token, {
      from: cy.id,
      amount: 30,
    });
    expect(cash).toMatchObject({ status: 'SUCCESS' });
    const settlement = await http.get(`${api}/settlements/${cash.result}`, { token: ann.token });
    expect(settlement.body).toMatchObject({ id: cash.result, from: cy.id, to: ann.id, amount: 30, status: 'paid' });
  });

  it('Ledger → Groups: an expense made in Ledger is shared with an account that is then deleted in Groups, which the members list names `Deleted account` under the same id', async () => {
    const { ann, cy, groupId } = await dinnerGroup('rel-members');
    const dinner = await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
      description: 'Lunch',
      amount: 20,
      date: DAY,
      splitBetween: [ann.id, cy.id],
    });
    expect(dinner).toMatchObject({ status: 'SUCCESS' });
    expect(await deleteMe(cy.token)).toMatchObject({ status: 'SUCCESS' });

    const members = (await http.get(`${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
      name: string;
    }[];
    expect(members.map(member => [member.memberId, member.name])).toEqual([
      [ann.id, 'Ann'],
      [cy.id, 'Deleted account'],
    ]);
    const expense = await http.get(`${api}/expenses/${dinner.result}`, { token: ann.token });
    expect(expense.body).toMatchObject({
      id: dinner.result,
      shares: expect.arrayContaining([expect.objectContaining({ memberId: cy.id })]),
    });
  });

  it('Settlements → Groups: a payment made in Settlements and waiting at the provider keeps its payer from deleting the account in Groups, until it is paid', async () => {
    const { ann, cy, groupId } = await dinnerGroup('rel-waiting');
    const paid = await command('POST', `${api}/groups/${groupId}/settlements/provider`, cy.token, {
      to: ann.id,
      amount: 30,
    });
    expect(paid).toMatchObject({ status: 'SUCCESS' });
    const settlementId = paid.result as string;

    expect(await deleteMe(cy.token)).toMatchObject({ status: 'ERROR', error: { type: 'PaymentWaitingAtTheProvider' } });

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
    expect((await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).body).toMatchObject({
      id: settlementId,
      status: 'paid',
    });

    expect(await deleteMe(cy.token)).toMatchObject({ status: 'SUCCESS' });
    // What the settlement made still reads, under the ids it was made with, and the administrators' log is unchanged.
    expect((await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).body).toMatchObject({
      id: settlementId,
      from: cy.id,
      to: ann.id,
    });
  });
});
