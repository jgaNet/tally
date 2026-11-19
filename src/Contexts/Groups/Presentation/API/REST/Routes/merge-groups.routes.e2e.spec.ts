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
      res.end(JSON.stringify({ id: `merge-${counter}`, payUrl: `https://pay.example/merge-${counter}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = 'merge-groups-secret';

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  // The server's date, read from an operation it answers: the application has one clock.
  const probeSignUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'merge-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `${name.toLowerCase()}-merge-${++accountCount}@example.com`;
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

/** A day of the month after next, within the year a recurring expense starts in, so the job records nothing in the test. */
function inTwoMonths() {
  const day = new Date(`${serverToday}T00:00:00.000Z`);
  day.setUTCDate(5);
  day.setUTCMonth(day.getUTCMonth() + 2);
  return day.toISOString().slice(0, 10);
}

const merge = (keptId: string, from: unknown, caller?: Person) =>
  send('POST', `/groups/${keptId}/merge`, caller?.token, from === undefined ? {} : { from });

describe('merging two groups (request 31)', () => {
  it('moves the members, the expenses, the settlements, the recurring expenses, the passed balances and the audit into the group kept', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const cat = await person('Cat');
    const dan = await person('Dan');
    const rent = await createGroup(ann, 'Rent');
    await join(rent, ann, bob);
    const groceries = await createGroup(ann, 'Groceries');
    await join(groceries, ann, cat);
    await join(groceries, ann, bob);
    await join(groceries, ann, dan);
    const leftInvitation = await invite(groceries, ann);

    const rentExpense = (await expense(rent, ann, 100, [ann, bob])).result as { id: string };
    const groceriesExpense = (await expense(groceries, cat, 90, [ann, cat, bob])).result as { id: string };
    await expense(groceries, dan, 40, [dan, ann]);
    const settled = await send('POST', `/groups/${groceries}/settlements/cash`, cat.token, {
      from: bob.id,
      amount: 30,
    });
    const settlementId = (settled.done as { result: { id: string } }).result.id;
    const recurring = await send('POST', `/groups/${groceries}/recurring`, cat.token, {
      description: 'Milk',
      amount: 30,
      startsOn: inTwoMonths(),
      splitBetween: [cat.id, ann.id],
    });
    const recurringId = (recurring.done as { result: { id: string } }).result.id;
    // Dan leaves owed 20: it passes to Ann, the owner.
    expect((await send('POST', `/groups/${groceries}/leave`, dan.token)).done).toMatchObject({ status: 'SUCCESS' });
    const before = await balancesOf(groceries, ann);
    const danBefore = await http.get(`${api}/groups/${groceries}/members/${dan.id}/statement`, { token: ann.token });
    expect(danBefore.status).toBe(200);
    const readBefore = await http.get(`${api}/expenses/${groceriesExpense.id}`, { token: ann.token });

    const merged = await merge(rent, groceries, ann);
    expect(merged.answer.status).toBe(202);
    expect(refusedBy(merged.done)).toBeUndefined();
    expect(merged.done).toMatchObject({ status: 'SUCCESS' });

    // The group merged is gone at once, for anyone, and its invitations let no one join.
    expect((await http.get(`${api}/groups/${groceries}`, { token: ann.token })).status).toBe(404);
    expect((await http.get(`${api}/groups/${groceries}`, { token: cat.token })).status).toBe(404);
    const mine = await http.get(`${api}/groups/mine`, { token: ann.token });
    expect((mine.body as Body[]).map(group => group.id)).toEqual([rent]);
    const stranger = await person('Eve');
    const accepted = await send('POST', `/invitations/${leftInvitation}/accept`, stranger.token);
    expect(accepted.done?.status ?? 'refused').not.toBe('SUCCESS');
    const late = await expense(groceries, cat, 10, [cat, ann]);
    expect(late.status).toBe('ERROR');

    // The members of the group merged joined the group kept after its members, as members; Bob stays where he was.
    const members = await http.get(`${api}/groups/${rent}/members`, { token: cat.token });
    expect((members.body as Body[]).map(member => [member.memberId, member.role])).toEqual([
      [ann.id, 'owner'],
      [bob.id, 'member'],
      [cat.id, 'member'],
    ]);

    // Within a few seconds, everything the group merged held is the group kept's, and each balance is the sum of the two.
    await eventually(async () => {
      const read = await http.get(`${api}/expenses/${groceriesExpense.id}`, { token: cat.token });
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ ...(readBefore.body as Body), groupId: rent });
      const settlement = await http.get(`${api}/settlements/${settlementId}`, { token: cat.token });
      expect(settlement.body).toMatchObject({ id: settlementId, groupId: rent, status: 'paid' });
    });
    await eventually(async () => {
      const after = await balancesOf(rent, ann);
      expect(after.get(ann.id)).toBe(50 + (before.get(ann.id) ?? 0));
      expect(after.get(bob.id)).toBe(-50 + (before.get(bob.id) ?? 0));
      expect(after.get(cat.id)).toBe(before.get(cat.id) ?? 0);
      expect([...after.values()].reduce((sum, balance) => sum + balance, 0)).toBe(0);
    });
    const listed = await http.get(`${api}/groups/${rent}/expenses`, { token: ann.token });
    expect((listed.body as Body[]).map(entry => entry.id)).toEqual(
      expect.arrayContaining([rentExpense.id, groceriesExpense.id]),
    );
    expect((listed.body as Body[]).every(entry => entry.groupId === rent)).toBe(true);
    const recurrings = await http.get(`${api}/groups/${rent}/recurring`, { token: ann.token });
    expect(recurrings.body as Body[]).toEqual([expect.objectContaining({ id: recurringId, groupId: rent })]);
    const settlements = await http.get(`${api}/groups/${rent}/settlements`, { token: ann.token });
    expect(settlements.body as Body[]).toEqual([expect.objectContaining({ id: settlementId, groupId: rent })]);

    // The audit of the group kept has the group merged's entries, with their ids, the balance passed included.
    const audit = await http.get(`${api}/groups/${rent}/audit`, { token: ann.token });
    const actions = (audit.body as Body[]).map(entry => entry.action);
    expect(actions.filter(action => action === 'expense-recorded')).toHaveLength(3);
    expect(actions).toEqual(expect.arrayContaining(['settlement-paid', 'balance-passed']));
    expect((audit.body as Body[]).find(entry => entry.action === 'balance-passed')?.id).toBe(
      `balance-passed:${groceries}:0`,
    );

    // Dan, who had left the group merged, is a former member of the group kept: his statement is read there.
    const statement = await http.get(`${api}/groups/${rent}/members/${dan.id}/statement`, { token: ann.token });
    expect(statement.status).toBe(200);
    expect(statement.body).toEqual(danBefore.body);
  });

  it('refuses a caller who does not own both, one group merged into itself, two currencies, and an archived group', async () => {
    const ann = await person('Owner');
    const bob = await person('Other');
    const kept = await createGroup(ann, 'Kept');
    const merged = await createGroup(ann, 'Merged');
    await join(kept, ann, bob);
    await join(merged, ann, bob);
    const bobs = await createGroup(bob, 'Bobs');
    await join(bobs, bob, ann);

    expect(refusedBy((await merge(kept, merged, bob)).done)).toBe('OnlyTheOwnerMerges');
    expect(refusedBy((await merge(kept, bobs, ann)).done)).toBe('OnlyTheOwnerMerges');
    expect(refusedBy((await merge(kept, kept, ann)).done)).toBe('GroupMergedIntoItself');
    const dollars = await createGroup(ann, 'Dollars', 'USD');
    expect(refusedBy((await merge(kept, dollars, ann)).done)).toBe('CurrenciesDiffer');
    const archived = await createGroup(ann, 'Archived');
    expect((await send('POST', `/groups/${archived}/archive`, ann.token)).done).toMatchObject({ status: 'SUCCESS' });
    expect(refusedBy((await merge(kept, archived, ann)).done)).toBe('GroupArchived');
    expect(refusedBy((await merge(archived, merged, ann)).done)).toBe('GroupArchived');
    const unknown = await merge(kept, 'no-such-group', ann);
    expect(unknown.done).toMatchObject({ status: 'ERROR' });

    expect((await http.get(`${api}/groups/${merged}`, { token: ann.token })).status).toBe(200);
  });

  it('refuses while a payment through the provider waits in the group merged', async () => {
    const ann = await person('Payee', 'acct-merge-payee');
    const bob = await person('Payer');
    const kept = await createGroup(ann, 'Kept');
    const merged = await createGroup(ann, 'Merged');
    await join(merged, ann, bob);
    await expense(merged, ann, 100, [ann, bob]);
    const paid = await send('POST', `/groups/${merged}/settlements/provider`, bob.token, { to: ann.id, amount: 50 });
    expect(paid.done).toMatchObject({ status: 'SUCCESS' });

    expect(refusedBy((await merge(kept, merged, ann)).done)).toBe('PaymentWaitingAtProvider');
    expect((await http.get(`${api}/groups/${merged}`, { token: ann.token })).status).toBe(200);
  });

  it('an expense recorded in the group merged at the moment it is merged is moved with the rest, once, or refused', async () => {
    const ann = await person('Racer');
    const bob = await person('Rival');
    const kept = await createGroup(ann, 'Kept');
    const merged = await createGroup(ann, 'Merged');
    await join(merged, ann, bob);

    const racing = Array.from({ length: 6 }, () => expense(merged, bob, 30, [ann, bob]));
    const [mergedDone, ...recorded] = await Promise.all([merge(kept, merged, ann), ...racing]);
    expect(mergedDone.done).toMatchObject({ status: 'SUCCESS' });
    const recordedIds = recorded
      .filter(done => done.status === 'SUCCESS')
      .map(done => (done.result as { id: string }).id);
    expect(recorded.every(done => done.status === 'SUCCESS' || done.status === 'ERROR')).toBe(true);

    await eventually(async () => {
      const listed = await http.get(`${api}/groups/${kept}/expenses`, { token: ann.token });
      expect((listed.body as Body[]).map(entry => entry.id).sort()).toEqual([...recordedIds].sort());
      const balances = await balancesOf(kept, ann);
      expect(balances.get(bob.id) ?? 0).toBe(15 * recordedIds.length);
      expect([...balances.values()].reduce((sum, balance) => sum + balance, 0)).toBe(0);
    });
  });

  it('refuses a body without its group merged by 400, and a caller not signed in by 401', async () => {
    const ann = await person('Shape');
    const kept = await createGroup(ann, 'Kept');
    expect((await merge(kept, undefined, ann)).answer.status).toBe(400);
    expect((await merge(kept, 42, ann)).answer.status).toBe(400);
    expect((await merge(kept, 'anything')).answer.status).toBe(401);
  });
});
