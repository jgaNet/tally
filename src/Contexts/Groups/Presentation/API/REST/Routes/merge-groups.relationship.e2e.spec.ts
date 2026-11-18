import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/** A stand-in for the payment provider, so a settlement can wait at it (request 13): it answers a payment with an id and a link. */
let provider: Server;
let counter = 0;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/accounts/acct-')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: decodeURIComponent((req.url ?? '').slice('/accounts/'.length)) }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `merge-${counter}`, payUrl: `https://pay.example/merge-${counter}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = 'merge-relationship-secret';

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  // The server's date, read from an operation it answers: the application has one clock.
  const probeSignUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'merge-rel-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((probeSignUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
});

type Body = Record<string, unknown>;
type Person = { token: string; id: string };

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Asks for a command and follows it to its outcome: the operation's body, or the answer when it is not a 202. */
async function send(method: string, path: string, token: string | undefined, body?: unknown) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined as Body | undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body };
}

/** The name of the rule an operation was refused by. */
function refusedBy(done: Body | undefined): string | undefined {
  return (done?.error as { type: string } | undefined)?.type;
}

/** What the request says is read "within a few seconds": asked again until it holds. */
async function eventually(check: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await check();
    } catch (error) {
      if (attempt >= 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
}

let accountCount = 0;

async function person(name: string, payoutAccount?: string): Promise<Person> {
  const email = `${name.toLowerCase()}-merge-rel-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  const id = (me.body as { id: string }).id;
  if (payoutAccount) await send('PUT', '/accounts/me/payout-account', token, { accountId: payoutAccount });
  return { token, id };
}

async function createGroup(owner: Person, name: string, currency = 'EUR') {
  const { done } = await send('POST', '/groups', owner.token, { name, currency });
  return (done as { result: { id: string } }).result.id;
}

async function invite(groupId: string, owner: Person) {
  const { done } = await send('POST', `/groups/${groupId}/invitations`, owner.token);
  return (done as { result: { id: string } }).result.id;
}

async function join(groupId: string, owner: Person, joiner: Person) {
  await send('POST', `/invitations/${await invite(groupId, owner)}/accept`, joiner.token);
}

async function expense(groupId: string, payer: Person, amount: number, between: Person[]) {
  const { done } = await send('POST', `/groups/${groupId}/expenses`, payer.token, {
    description: 'Shared',
    amount,
    date: serverToday,
    splitBetween: between.map(member => member.id),
  });
  return done as Body;
}

async function balancesOf(groupId: string, reader: Person) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token: reader.token });
  return new Map((body as { memberId: string; balance: number }[]).map(entry => [entry.memberId, entry.balance]));
}

const merge = (keptId: string, from: unknown, caller?: Person) =>
  send('POST', `/groups/${keptId}/merge`, caller?.token, from === undefined ? {} : { from });

describe('Groups → Ledger (GroupsMerged, GroupMembers, GroupCurrency, PassedBalances): what Ledger holds of a group merged is read in the group kept, by the id Groups answered', () => {
  it("reads the group merged's expense, its passed balance and the members of both in the group kept, by the kept group's id", async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const dan = await person('Dan');
    const kept = await createGroup(ann, 'Rent');
    const merged = await createGroup(ann, 'Groceries');
    await join(merged, ann, bob);
    await join(merged, ann, dan);
    const recorded = (await expense(merged, bob, 60, [ann, bob])).result as { id: string };
    await expense(merged, dan, 40, [dan, ann]);
    await send('POST', `/groups/${merged}/leave`, dan.token);

    expect((await merge(kept, merged, ann)).done).toMatchObject({ status: 'SUCCESS' });

    await eventually(async () => {
      const read = await http.get(`${api}/expenses/${recorded.id}`, { token: bob.token });
      expect(read.body).toMatchObject({ id: recorded.id, groupId: kept, paidBy: bob.id, version: 1 });
    });
    const audit = await http.get(`${api}/groups/${kept}/audit`, { token: ann.token });
    expect(audit.body as Body[]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'expense-recorded', subjectId: recorded.id }),
        expect.objectContaining({ id: `balance-passed:${merged}:0`, action: 'balance-passed', by: dan.id }),
      ]),
    );
    const late = await expense(kept, bob, 10, [ann, bob]);
    expect(late).toMatchObject({ status: 'SUCCESS' });
  });
});

describe('Groups → Settlements (GroupsMerged): a settlement of a group merged is read in the group kept, by its own id', () => {
  it('reads the settlement recorded in the group merged among the settlements of the group kept', async () => {
    const ann = await person('Cy');
    const bob = await person('Di');
    const kept = await createGroup(ann, 'Kept');
    const merged = await createGroup(ann, 'Merged');
    await join(merged, ann, bob);
    await expense(merged, ann, 100, [ann, bob]);
    const settled = await send('POST', `/groups/${merged}/settlements/cash`, ann.token, { from: bob.id, amount: 50 });
    const settlementId = (settled.done as { result: { id: string } }).result.id;

    expect((await merge(kept, merged, ann)).done).toMatchObject({ status: 'SUCCESS' });

    await eventually(async () => {
      const listed = await http.get(`${api}/groups/${kept}/settlements`, { token: bob.token });
      expect(listed.body as Body[]).toEqual([
        expect.objectContaining({
          id: settlementId,
          groupId: kept,
          status: 'paid',
          history: [expect.objectContaining({ status: 'paid' })],
        }),
      ]);
    });
    const balances = await balancesOf(kept, ann);
    expect(balances.get(ann.id) ?? 0).toBe(0);
    expect(balances.get(bob.id) ?? 0).toBe(0);
  });
});

describe('Settlements → Groups (WaitingPayments): a payment Settlements keeps at the provider is one Groups reads, by the group id it answers', () => {
  it('refuses the merge while a payment waits at the provider in the group merged, which stays as it was', async () => {
    const ann = await person('Gus', 'acct-merge-gus');
    const bob = await person('Hal');
    const kept = await createGroup(ann, 'Kept');
    const merged = await createGroup(ann, 'Merged');
    await join(merged, ann, bob);
    await expense(merged, ann, 100, [ann, bob]);
    const paid = await send('POST', `/groups/${merged}/settlements/provider`, bob.token, { to: ann.id, amount: 50 });
    const settlementId = (paid.done as { result: { id: string } }).result.id;
    expect(settlementId).toBeTruthy();

    expect(refusedBy((await merge(kept, merged, ann)).done)).toBe('PaymentWaitingAtProvider');
    const listed = await http.get(`${api}/groups/${merged}/settlements`, { token: ann.token });
    expect(listed.body as Body[]).toEqual([
      expect.objectContaining({ id: settlementId, groupId: merged, status: 'pending' }),
    ]);
    expect((await http.get(`${api}/groups/${merged}`, { token: ann.token })).status).toBe(200);
  });
});
