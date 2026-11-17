import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A stand-in for the payment provider (request 16): it knows the accounts `acct-known` and `acct-other`, answers 404 for any
 * other account, and 500 for `acct-broken`. It records the payments it is asked for.
 */
let provider: Server;
let asked: { reference: string; amount: number; currency: string; payee: string }[] = [];

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && account) {
        const accountId = decodeURIComponent(account[1]);
        if (accountId === 'acct-broken') {
          res.writeHead(500).end();
          return;
        }
        if (accountId !== 'acct-known' && accountId !== 'acct-other') {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: accountId }));
        return;
      }
      if (req.method === 'POST' && req.url === '/payments') {
        asked.push(JSON.parse(data));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `prov-${asked.length}`, payUrl: `https://pay.example/prov-${asked.length}` }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'payout-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
});

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `payout-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** The person asks to set their payout account, and follows it to its outcome. */
async function setPayoutAccount(token: string, accountId: string) {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

/** Creates a group in EUR and answers its id. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Trip', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Ann paid 60 for dinner, split with Bob: Bob owes Ann 30. */
async function owing(name: string) {
  const ann = await person(`${name}Ann`);
  const bob = await person(`${name}Bob`);
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: serverToday, splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  await outcome((recorded.body as Body).operationId as string, ann.token);
  return { ann, bob, groupId };
}

/** Asks to pay another member through the provider, and follows it to its outcome. */
async function payThroughProvider(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

describe('Payout accounts (request 16): a person sets the account the provider knows, and reads their own', () => {
  it('sets the account the provider knows, and the person reads it back as their own', async () => {
    const ann = await person('KnownAnn');

    expect(await setPayoutAccount(ann.token, 'acct-known')).toMatchObject({ status: 'SUCCESS' });

    const read = await http.get(`${api}/accounts/me/payout-account`, { token: ann.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ accountId: 'acct-known' });
  });

  it('answers 404 to a person who has set none, and nobody else reads a person’s account', async () => {
    const ann = await person('NoneAnn');
    const bob = await person('NoneBob');
    await setPayoutAccount(ann.token, 'acct-known');

    expect((await http.get(`${api}/accounts/me/payout-account`, { token: bob.token })).status).toBe(404);
    expect((await http.get(`${api}/accounts/me/payout-account`, { token: ann.token })).body).toEqual({
      accountId: 'acct-known',
    });
  });

  it('refuses an account the provider does not know by its name, and keeps the one the person had', async () => {
    const ann = await person('UnknownAnn');
    await setPayoutAccount(ann.token, 'acct-known');

    const refused = await setPayoutAccount(ann.token, 'acct-nobody');
    expect(refused.status).toBe('ERROR');
    expect(refused.body.error).toMatchObject({ type: 'UnknownPayoutAccount' });

    const read = await http.get(`${api}/accounts/me/payout-account`, { token: ann.token });
    expect(read.body).toEqual({ accountId: 'acct-known' });
  });

  it('refuses an answer the provider gives that is not an answer it can give, and sets nothing', async () => {
    const ann = await person('BrokenAnn');

    const refused = await setPayoutAccount(ann.token, 'acct-broken');
    expect(refused.status).toBe('ERROR');
    expect(refused.body.error).toMatchObject({ type: 'ProviderAccountUnavailable' });

    expect((await http.get(`${api}/accounts/me/payout-account`, { token: ann.token })).status).toBe(404);
  });

  it('replaces the account a person had with another one the provider knows', async () => {
    const ann = await person('ReplaceAnn');
    await setPayoutAccount(ann.token, 'acct-known');

    expect(await setPayoutAccount(ann.token, 'acct-other')).toMatchObject({ status: 'SUCCESS' });

    const read = await http.get(`${api}/accounts/me/payout-account`, { token: ann.token });
    expect(read.body).toEqual({ accountId: 'acct-other' });
  });

  it('refuses a caller who is not signed in with 401, to set or to read', async () => {
    const put = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: 'acct-known' } });
    expect(put.status).toBe(401);

    const get = await http.get(`${api}/accounts/me/payout-account`);
    expect(get.status).toBe(401);
  });
});

describe('Payout accounts → payments: a payment through the provider is paid to the payee’s account, and needs one', () => {
  it('refuses a payment to a payee with no payout account by name, and asks the provider nothing', async () => {
    const { ann, bob, groupId } = await owing('NoAccount');
    asked = [];

    const refused = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });

    expect(refused.status).toBe('ERROR');
    expect(refused.body.error).toMatchObject({ type: 'PayeeHasNoPayoutAccount' });
    expect(asked).toEqual([]);
  });

  it('asks the provider to pay the payee’s account, and asks nothing for a settlement in cash', async () => {
    const { ann, bob, groupId } = await owing('WithAccount');
    await setPayoutAccount(ann.token, 'acct-known');
    asked = [];

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });

    expect(paid.status).toBe('SUCCESS');
    expect(asked).toEqual([
      { reference: (paid.body.result as { id: string }).id, amount: 30, currency: 'EUR', payee: 'acct-known' },
    ]);
  });

  it('pays the payee’s account as it is at the moment the payment is asked: a replaced account is the one paid', async () => {
    const { ann, bob, groupId } = await owing('Replaced');
    await setPayoutAccount(ann.token, 'acct-known');
    await setPayoutAccount(ann.token, 'acct-other');
    asked = [];

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });

    expect(paid.status).toBe('SUCCESS');
    expect(asked.map(payment => payment.payee)).toEqual(['acct-other']);
  });

  it('settles in cash without a payout account', async () => {
    const { ann, bob, groupId } = await owing('Cash');

    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 30 },
      token: ann.token,
    });
    const done = await outcome((answer.body as Body).operationId as string, ann.token);

    expect(done.body.status).toBe('SUCCESS');
  });
});
