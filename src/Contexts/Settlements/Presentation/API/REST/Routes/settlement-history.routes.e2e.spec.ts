import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'history-test-secret';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
/** Every payment link the provider gave, in the order it gave them: the payment's id there, and the settlement it is for. */
const issued: Array<{ paymentId: string; reference: string }> = [];
let previousEnv: { url?: string; secret?: string };

beforeAll(async () => {
  // A stand-in for the provider: it answers the payment link, the refund and the payout account the way its API says.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        const accountId = decodeURIComponent(request.url.slice('/accounts/'.length));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: accountId }));
        return;
      }
      if (request.url?.endsWith('/refunds')) {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'refund' }));
        return;
      }
      const body = JSON.parse(text) as { reference: string };
      const paymentId = `pay_${issued.length + 1}`;
      issued.push({ paymentId, reference: body.reference });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: paymentId, fee: 0, payUrl: `https://pay.example/${paymentId}` }));
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
type Line = { status: string; at: string };
type Listed = { id: string; status: string; method: string; history: Line[] };

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;
const PAST_DAY = '2026-03-10';

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

/** Signs someone up and in, and sets the payout account the provider knows for them, so that they can be paid through it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  const person = { id: operation.result as string, token: (login.body as { token: string }).token };
  const account = await http.request('PUT', `${api}/accounts/me/payout-account`, {
    token: person.token,
    body: { accountId: `payout_${person.id}` },
  });
  expect(await outcome((account.body as { operationId: string }).operationId, person.token)).toMatchObject({
    status: 'SUCCESS',
  });
  return person;
}

async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** Records an expense paid by the token's member, split equally between the ids given, and follows its operation. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Records a settlement in cash from `from` to the token's member (the payee), and follows its operation: the result is its id. */
async function recordCash(token: string, groupId: string, from: string, amount: number): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
    token,
    body: { from, amount },
  });
  const operation = await outcome((answer.body as { operationId: string }).operationId, token);
  expect(operation).toMatchObject({ status: 'SUCCESS' });
  return operation.result as string;
}

/** Asks to pay another member through the provider, and follows its operation: the result is the settlement's id. */
async function payThroughProvider(token: string, groupId: string, to: string, amount: number): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    token,
    body: { to, amount },
  });
  const operation = await outcome((answer.body as { operationId: string }).operationId, token);
  expect(operation).toMatchObject({ status: 'SUCCESS' });
  return operation.result as string;
}

/** Asks the provider to refund a paid settlement, as its payee, and follows its operation. */
async function refund(token: string, settlementId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** The provider's webhook, signed with the secret it shares with Tally, as it is sent. */
async function webhook(body: object): Promise<{ status: number; body: unknown }> {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, { body, headers: { 'provider-signature': signature } });
}

/** A webhook about a payment the provider gave a link for, saying what became of it. */
const says = (paymentId: string, status: string, id: string) =>
  webhook({ id, paymentId, status, at: '2026-11-17T10:00:00Z' });

/** The provider's id of the last payment it gave a link for. */
const lastPayment = () => issued[issued.length - 1].paymentId;

const listOf = (token: string | undefined, groupId: string) =>
  http.get(`${api}/groups/${groupId}/settlements`, { token });

const oneOf = (token: string, settlementId: string) => http.get(`${api}/settlements/${settlementId}`, { token });

describe("a group's settlements (request 19)", () => {
  it('lists every settlement of the group the most recent first, each with every status it has had, the earliest first', async () => {
    const ann = await signedIn('sh-ann@example.com', 'Ann');
    const bob = await signedIn('sh-bob@example.com', 'Bob');
    const cy = await signedIn('sh-cy@example.com', 'Cy');
    const groupId = await createGroup(ann.token, 'History');
    await join(ann.token, groupId, bob.token);
    await join(ann.token, groupId, cy.token);
    // Ann paid 300, split three ways: Bob and Cy each owe 100.
    expect(
      await record(ann.token, groupId, {
        description: 'Dinner',
        amount: 300,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id, cy.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const first = await recordCash(ann.token, groupId, bob.id, 40);
    const second = await recordCash(ann.token, groupId, cy.id, 50);
    const third = await payThroughProvider(bob.token, groupId, ann.id, 20);
    const paymentId = lastPayment();
    expect(await says(paymentId, 'succeeded', 'wh_1')).toMatchObject({ status: 202 });
    expect(await refund(ann.token, third)).toMatchObject({ status: 'SUCCESS' });
    expect(await says(paymentId, 'refunded', 'wh_2')).toMatchObject({ status: 202 });

    const read = await listOf(bob.token, groupId);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      {
        id: third,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 20,
        method: 'provider',
        status: 'refunded',
        at: expect.stringMatching(ISO_TIME),
        payUrl: `https://pay.example/${paymentId}`,
        // Asked through the provider from request 38 on, so it reads the fee it was asked with (the provider gave none here: 0, borne by the payee).
        fee: { amount: 0, borneBy: 'payee' },
        history: [
          { status: 'pending', at: expect.stringMatching(ISO_TIME) },
          { status: 'paid', at: expect.stringMatching(ISO_TIME) },
          { status: 'refunding', at: expect.stringMatching(ISO_TIME) },
          { status: 'refunded', at: expect.stringMatching(ISO_TIME) },
        ],
      },
      {
        id: second,
        groupId,
        from: cy.id,
        to: ann.id,
        amount: 50,
        method: 'cash',
        status: 'paid',
        at: expect.stringMatching(ISO_TIME),
        history: [{ status: 'paid', at: expect.stringMatching(ISO_TIME) }],
      },
      {
        id: first,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 40,
        method: 'cash',
        status: 'paid',
        at: expect.stringMatching(ISO_TIME),
        history: [{ status: 'paid', at: expect.stringMatching(ISO_TIME) }],
      },
    ]);

    // One settlement read by its id carries the same history as the list does.
    const listed = (read.body as Listed[])[0];
    expect(await oneOf(bob.token, third)).toMatchObject({ status: 200, body: { history: listed.history } });
  });

  it('adds nothing for a webhook that changes nothing, and a failed payment has the pending and the failed status only', async () => {
    const ann = await signedIn('sh2-ann@example.com', 'Ann');
    const bob = await signedIn('sh2-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Failing');
    await join(ann.token, groupId, bob.token);
    expect(
      await record(ann.token, groupId, {
        description: 'Coffee',
        amount: 100,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const settlementId = await payThroughProvider(bob.token, groupId, ann.id, 10);
    const paymentId = lastPayment();
    expect(await says(paymentId, 'failed', 'wh_f1')).toMatchObject({ status: 202 });
    expect(await says(paymentId, 'failed', 'wh_f2')).toMatchObject({ status: 202 });
    expect(await says(paymentId, 'succeeded', 'wh_f3')).toMatchObject({ status: 202 });

    expect(await oneOf(bob.token, settlementId)).toMatchObject({
      status: 200,
      body: {
        status: 'failed',
        history: [
          { status: 'pending', at: expect.stringMatching(ISO_TIME) },
          { status: 'failed', at: expect.stringMatching(ISO_TIME) },
        ],
      },
    });
  });

  it('a refund that overtakes the success of its payment adds only the refunded status, never the paid it did not have', async () => {
    const ann = await signedIn('sh3-ann@example.com', 'Ann');
    const bob = await signedIn('sh3-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Overtaken');
    await join(ann.token, groupId, bob.token);
    expect(
      await record(ann.token, groupId, {
        description: 'Tea',
        amount: 100,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const settlementId = await payThroughProvider(bob.token, groupId, ann.id, 5);
    expect(await says(lastPayment(), 'refunded', 'wh_o1')).toMatchObject({ status: 202 });

    expect(await oneOf(bob.token, settlementId)).toMatchObject({
      body: {
        status: 'refunded',
        history: [
          { status: 'pending', at: expect.stringMatching(ISO_TIME) },
          { status: 'refunded', at: expect.stringMatching(ISO_TIME) },
        ],
      },
    });
  });

  it('keeps a settlement in the group after its payer has left, and refuses a member who left, a stranger and an anonymous caller', async () => {
    const ann = await signedIn('sh4-ann@example.com', 'Ann');
    const cy = await signedIn('sh4-cy@example.com', 'Cy');
    const dan = await signedIn('sh4-dan@example.com', 'Dan');
    const groupId = await createGroup(ann.token, 'Leaver');
    await join(ann.token, groupId, cy.token);
    // Ann paid 200, split between Ann and Cy: Cy owes 100, and pays it in cash to be at 0 and to leave.
    expect(
      await record(ann.token, groupId, {
        description: 'Hotel',
        amount: 200,
        date: PAST_DAY,
        splitBetween: [ann.id, cy.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    const settlementId = await recordCash(ann.token, groupId, cy.id, 100);

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: cy.token });
    expect(await outcome((left.body as { operationId: string }).operationId, cy.token)).toMatchObject({
      status: 'SUCCESS',
    });

    expect(await listOf(ann.token, groupId)).toMatchObject({
      status: 200,
      body: [
        {
          id: settlementId,
          from: cy.id,
          to: ann.id,
          status: 'paid',
          history: [{ status: 'paid', at: expect.stringMatching(ISO_TIME) }],
        },
      ],
    });
    expect(await listOf(cy.token, groupId)).toMatchObject({ status: 404 });
    expect(await listOf(dan.token, groupId)).toMatchObject({ status: 404 });
    expect(await listOf(undefined, groupId)).toMatchObject({ status: 401 });
  });
});

describe('Groups → Settlements (request 19)', () => {
  it('makes the group through Groups, keeps the id its creation answered, and finds its settlements through Settlements by that same id', async () => {
    const ann = await signedIn('g19-ann@example.com', 'Ann');
    const bob = await signedIn('g19-bob@example.com', 'Bob');
    // The group's id is the one Groups' creation answered: Settlements is read with it, and finds the group's settlements by it.
    const groupId = await createGroup(ann.token, 'Made in Groups');
    await join(ann.token, groupId, bob.token);
    expect(
      await record(ann.token, groupId, {
        description: 'Lunch',
        amount: 80,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    const settlementId = await recordCash(ann.token, groupId, bob.id, 40);

    expect(await listOf(bob.token, groupId)).toMatchObject({
      status: 200,
      body: [{ id: settlementId, groupId, from: bob.id, to: ann.id, history: [{ status: 'paid' }] }],
    });
  });
});
