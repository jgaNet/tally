import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('merge');

const WEBHOOK_SECRET = 'a-shared-secret-for-the-merging';

/**
 * The payment provider, as a server of its own (as the archiving suite has it): it answers a payment with a link, and a payout account is
 * known to it. A merge is refused while a payment through it waits (request 31).
 */
let providerServer: Server;
let paymentCount = 0;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => resolve(text));
  });

const answer = (response: ServerResponse, status: number, body?: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    await readBody(request);
    const url = request.url ?? '';
    if (request.method === 'POST' && url === '/payments') {
      paymentCount += 1;
      return answer(response, 201, { id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}` });
    }
    if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(url)) {
      return answer(response, 200, { id: decodeURIComponent(url.slice('/accounts/'.length)) });
    }
    return answer(response, 404);
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;

  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => providerServer.close(() => resolve()));
  delete process.env.PROVIDER_URL;
  delete process.env.PROVIDER_WEBHOOK_SECRET;
});

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group made by its owner, answering its id, and the joiner's account joined to it by an invitation. */
async function groupWith(owner: { token: string }, currency: string, joiner?: { token: string }): Promise<string> {
  const created = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  if (joiner) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const merge = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/merge`, { body, token });
const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });

/**
 * Reads what a read answers until `check` holds: the reactions of a merge run in transactions of their own, a few moments after the merge
 * answers (request 31). Gives up after five seconds and answers the last reading.
 */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !check(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

describe('Groups → Ledger (GroupsMerged)', () => {
  it('merges a group into another, made in Groups: Ledger finds the group kept by the id Groups answered, with the expenses, balances and members of both', async () => {
    const ada = await signedIn('merge-ada@example.com', 'Ada');
    const bob = await signedIn('merge-bob@example.com', 'Bob');
    const carol = await signedIn('merge-carol@example.com', 'Carol');
    const kept = await groupWith(ada, 'EUR', bob);
    const merged = await groupWith(ada, 'EUR', carol);

    await record(kept, ada.token, {
      description: 'Dinner',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [ada.id, bob.id],
    });
    const rent = await record(merged, ada.token, {
      description: 'Rent',
      amount: 600,
      date: '2026-01-16',
      splitBetween: [ada.id, carol.id],
    });
    const rentId = (rent.body as { id: string }).id;

    expect(await merge(kept, ada.token, { from: merged })).toMatchObject({ status: 204 });

    // The group merged is gone for anyone, at once.
    expect(await http.request('GET', `${api}/groups/${merged}`, { token: ada.token })).toMatchObject({ status: 404 });
    expect(await http.request('GET', `${api}/groups/${merged}`, { token: carol.token })).toMatchObject({ status: 404 });

    // The members of the group merged join the group kept after its own, as members.
    const members = await eventually(
      async () => http.request('GET', `${api}/groups/${kept}/members`, { token: ada.token }),
      reading => Array.isArray(reading.body) && reading.body.length === 3,
    );
    expect(members).toMatchObject({
      status: 200,
      body: [
        expect.objectContaining({ memberId: ada.id, role: 'owner' }),
        expect.objectContaining({ memberId: bob.id, role: 'member' }),
        expect.objectContaining({ memberId: carol.id, role: 'member' }),
      ],
    });

    // Ada is owed 500 + 300, Bob owes 500, Carol 300: each balance is what it was in either group, and they add up to 0.
    const balances = await eventually(
      async () => http.request('GET', `${api}/groups/${kept}/balances`, { token: ada.token }),
      reading => Array.isArray(reading.body) && reading.body.some((row: { balance: number }) => row.balance === 800),
    );
    expect(balances).toMatchObject({
      status: 200,
      body: [
        { memberId: ada.id, balance: 800 },
        { memberId: bob.id, balance: -500 },
        { memberId: carol.id, balance: -300 },
      ],
    });

    // The expenses of the group merged are the group kept's, at their place: the latest first, each keeping its id.
    const expenses = await eventually(
      async () => http.request('GET', `${api}/groups/${kept}/expenses`, { token: ada.token }),
      reading => Array.isArray(reading.body) && reading.body.length === 2,
    );
    expect(expenses).toMatchObject({
      status: 200,
      body: [expect.objectContaining({ id: rentId, groupId: kept }), expect.objectContaining({ groupId: kept })],
    });
  });
});

describe('Groups → Settlements (GroupsMerged)', () => {
  it('merges a group whose settlement is recorded in Settlements: the settlement is the group kept’s, found by its id', async () => {
    const ada = await signedIn('merge-settle-ada@example.com', 'Ada');
    const carol = await signedIn('merge-settle-carol@example.com', 'Carol');
    const kept = await groupWith(ada, 'EUR');
    const merged = await groupWith(ada, 'EUR', carol);
    await record(merged, ada.token, {
      description: 'Rent',
      amount: 600,
      date: '2026-01-16',
      splitBetween: [ada.id, carol.id],
    });

    // Carol pays Ada 100 of what she owes in the group merged.
    const cash = await http.request('POST', `${api}/groups/${merged}/settlements/cash`, {
      body: { from: carol.id, amount: 100 },
      token: ada.token,
    });
    expect(cash.status).toBe(201);
    const settlementId = (cash.body as { id: string }).id;

    expect(await merge(kept, ada.token, { from: merged })).toMatchObject({ status: 204 });

    expect(
      await eventually(
        async () => http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token }),
        reading => (reading.body as { groupId?: string }).groupId === kept,
      ),
    ).toMatchObject({
      status: 200,
      body: { id: settlementId, groupId: kept, from: carol.id, to: ada.id, amount: 100 },
    });
    expect(
      await eventually(
        async () => http.request('GET', `${api}/groups/${kept}/settlements`, { token: ada.token }),
        reading => Array.isArray(reading.body) && reading.body.length === 1,
      ),
    ).toMatchObject({ status: 200, body: [expect.objectContaining({ id: settlementId, groupId: kept })] });
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('refuses a merge while a payment of the group merged waits at the provider, which Groups reads, and the group merged stays', async () => {
    const ada = await signedIn('merge-waiting-ada@example.com', 'Ada');
    const bob = await signedIn('merge-waiting-bob@example.com', 'Bob');
    const kept = await groupWith(ada, 'EUR');
    const merged = await groupWith(ada, 'EUR', bob);
    // Ada is paid through the provider, so she has a payout account at it (request 16).
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct-${ada.id}` },
      token: ada.token,
    });
    await record(merged, ada.token, {
      description: 'Dinner',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [ada.id, bob.id],
    });

    const paid = await http.request('POST', `${api}/groups/${merged}/settlements/provider`, {
      body: { to: ada.id, amount: 500 },
      token: bob.token,
    });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;

    expect(await merge(kept, ada.token, { from: merged })).toMatchObject({
      status: 422,
      body: { type: 'MergePaymentsWaiting' },
    });
    expect(await http.request('GET', `${api}/groups/${merged}`, { token: ada.token })).toMatchObject({ status: 200 });
    expect(await http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token })).toMatchObject({
      status: 200,
      body: { id: settlementId, groupId: merged, status: 'pending' },
    });
  });
});

describe('Groups merge refusals (request 31)', () => {
  it('refuses a merge of two groups in different currencies, of a group into itself, and by a member who does not own both', async () => {
    const ada = await signedIn('merge-refused-ada@example.com', 'Ada');
    const bob = await signedIn('merge-refused-bob@example.com', 'Bob');
    const eur = await groupWith(ada, 'EUR', bob);
    const usd = await groupWith(ada, 'USD');

    expect(await merge(eur, ada.token, { from: usd })).toMatchObject({
      status: 422,
      body: { type: 'CurrenciesDiffer' },
    });
    expect(await merge(eur, ada.token, { from: eur })).toMatchObject({
      status: 422,
      body: { type: 'MergeIntoItself' },
    });
    // Bob is a member of both groups, but owns neither: the merge is refused, and nothing moves.
    const other = await groupWith(ada, 'EUR', bob);
    expect(await merge(eur, bob.token, { from: other })).toMatchObject({ body: { type: 'NotAllowed' } });
    // A group Bob is not a member of does not exist for him.
    expect(await merge(eur, bob.token, { from: usd })).toMatchObject({ status: 404 });
    // The group merged is named in the body, as a string.
    expect(await http.request('POST', `${api}/groups/${eur}/merge`, { body: {}, token: ada.token })).toMatchObject({
      status: 400,
    });
    expect(await http.request('GET', `${api}/groups/${other}`, { token: ada.token })).toMatchObject({ status: 200 });
  });
});
