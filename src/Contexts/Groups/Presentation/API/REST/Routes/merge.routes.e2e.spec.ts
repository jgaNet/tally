import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Balance = { memberId: string; balance: number };
type Member = { memberId: string };
type Expense = { id: string; description: string; amount: number };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Answers a command: a 202 is followed to its end, anything else is its status. */
async function answered(request: Promise<{ status: number; body: unknown }>, token: string): Promise<Operation> {
  const answer = await request;
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` };
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Reads until the read is what the test waits for: a move is made within seconds, after the command answered. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 200 && !done(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

/** Signs someone up and in: their account's id, and the token that names it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

async function createGroup(token: string, name: string, currency: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Bob joins the group by an invitation, from its owner. */
async function join(ownerToken: string, bobToken: string, groupId: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ownerToken });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ownerToken)).result as string;
  await answered(http.request('POST', `${api}/invitations/${invitation}/accept`, { token: bobToken }), bobToken);
}

const merge = (token: string, groupId: string, from: string) =>
  answered(http.request('POST', `${api}/groups/${groupId}/merge`, { token, body: { from } }), token);

describe('Merging two groups of one currency (request 31)', () => {
  it('moves the members, expenses and balances of the group merged into the group kept, and the group merged is gone', async () => {
    const ann = await signedIn('ann.merge@example.test', 'Ann');
    const bob = await signedIn('bob.merge@example.test', 'Bob');
    const flat = await createGroup(ann.token, 'Flat', 'EUR');
    const groceries = await createGroup(ann.token, 'Groceries', 'EUR');
    await join(ann.token, bob.token, groceries);
    const dinner = await answered(
      http.request('POST', `${api}/groups/${groceries}/expenses`, {
        token: ann.token,
        body: { description: 'Dinner', amount: 3000, date: '2026-11-01', splitBetween: [ann.id, bob.id] },
      }),
      ann.token,
    );
    expect(dinner.status).toBe('SUCCESS');

    expect(await merge(ann.token, flat, groceries)).toEqual(expect.objectContaining({ status: 'SUCCESS' }));

    // The group merged is gone at once, for anyone.
    expect((await http.get(`${api}/groups/${groceries}`, { token: ann.token })).status).toBe(404);
    expect((await http.get(`${api}/groups/${groceries}`, { token: bob.token })).status).toBe(404);

    // Bob, a member of the group merged, is a member of the group kept after the members who were there.
    const members = (await http.get(`${api}/groups/${flat}/members`, { token: ann.token })).body as Member[];
    expect(members.map(member => member.memberId)).toEqual([ann.id, bob.id]);

    // The expense moved, and the balances of the group kept are the two members' shares of it, within seconds.
    const expenses = await eventually(
      async () => (await http.get(`${api}/groups/${flat}/expenses`, { token: ann.token })).body as Expense[],
      list => list.length === 1,
    );
    expect(expenses.map(expense => expense.description)).toEqual(['Dinner']);
    const balances = await eventually(
      async () => (await http.get(`${api}/groups/${flat}/balances`, { token: ann.token })).body as Balance[],
      list => list.some(row => row.balance !== 0),
    );
    const total = balances.reduce((sum, row) => sum + row.balance, 0);
    expect(total).toBe(0);
    expect(balances.find(row => row.memberId === ann.id)?.balance).toBe(1500);
    expect(balances.find(row => row.memberId === bob.id)?.balance).toBe(-1500);
  });

  it('is refused by its rule: a group in another currency, the same group, and a group the caller does not own', async () => {
    const ann = await signedIn('ann.merge2@example.test', 'Ann');
    const bob = await signedIn('bob.merge2@example.test', 'Bob');
    const home = await createGroup(ann.token, 'Home', 'EUR');
    const trip = await createGroup(ann.token, 'Trip', 'USD');
    const bobs = await createGroup(bob.token, 'Bobs', 'EUR');
    await join(ann.token, bob.token, home);

    expect(await merge(ann.token, home, trip)).toEqual(expect.objectContaining({ status: 'ERROR' }));
    expect((await merge(ann.token, home, trip)).error?.type).toBe('CurrenciesDiffer');
    expect((await merge(ann.token, home, home)).error?.type).toBe('MergeIntoItself');
    // Bob is a member of the group kept and of his own, but does not own the group kept.
    expect((await merge(bob.token, home, bobs)).error?.type).toBe('OnlyTheOwnerMayMerge');
    // Nothing moved: both groups still read as they were.
    expect((await http.get(`${api}/groups/${trip}`, { token: ann.token })).status).toBe(200);
    expect((await http.get(`${api}/groups/${bobs}`, { token: bob.token })).status).toBe(200);
  });
});
