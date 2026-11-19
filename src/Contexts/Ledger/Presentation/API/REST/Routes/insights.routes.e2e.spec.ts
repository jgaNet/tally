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
  const email = `${name.toLowerCase()}-insights-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in a currency, with its owner, and answers its id. */
async function createGroup(owner: { token: string }, name: string, currency: string) {
  const answer = await http.request('POST', `${api}/groups`, { body: { name, currency }, token: owner.token });
  return ((await outcome((answer.body as Body).operationId as string, owner.token)).body as { result: { id: string } })
    .result.id;
}

/** Has the other person join the group, by an invitation of its owner. */
async function join(owner: { token: string }, groupId: string, other: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: other.token });
  await outcome((accepted.body as Body).operationId as string, other.token);
}

/** Records an expense, the operation followed to its outcome: answers the expense's id. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result: { id: string } }).result.id;
}

/** Reads the insights of a person, answered as a list of lines in the `YYYY-MM currency category amount` form. */
async function linesOf(token: string) {
  const read = await http.get(`${api}/accounts/me/insights`, { token });
  expect(read.status).toBe(200);
  return (read.body as { month: string; currency: string; category: string; amount: number }[]).map(
    line => `${line.month} ${line.currency} ${line.category} ${line.amount}`,
  );
}

describe('spending insights (request 37)', () => {
  it('reads each person’s own shares by month, currency and category, in the stated order', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const flat = await createGroup(ann, 'Flat', 'EUR');
    await join(ann, flat, bob);
    const trip = await createGroup(ann, 'Trip', 'CHF');
    await join(ann, trip, bob);

    // Ann's share of the flat's groceries is 4000 in March and 3500 in April, in euros.
    await record(ann.token, flat, {
      description: 'Shop',
      amount: 10000,
      date: '2026-03-14',
      category: 'groceries',
      splitExactly: [
        { memberId: ann.id, amount: 4000 },
        { memberId: bob.id, amount: 6000 },
      ],
    });
    await record(ann.token, flat, {
      description: 'Shop again',
      amount: 7000,
      date: '2026-04-02',
      category: 'groceries',
      splitExactly: [
        { memberId: ann.id, amount: 3500 },
        { memberId: bob.id, amount: 3500 },
      ],
    });
    // Her share of a trip's travel is 25000 in April, in Swiss francs.
    await record(ann.token, trip, {
      description: 'Train',
      amount: 25000,
      date: '2026-04-20',
      category: 'travel',
      splitBetween: [ann.id],
    });

    expect(await linesOf(ann.token)).toEqual([
      '2026-03 EUR groceries 4000',
      '2026-04 CHF travel 25000',
      '2026-04 EUR groceries 3500',
    ]);
    // Bob reads only his own shares: 6000 in March and 3500 in April, in euros, and none of the trip.
    expect(await linesOf(bob.token)).toEqual(['2026-03 EUR groceries 6000', '2026-04 EUR groceries 3500']);
  });

  it('counts a deleted expense for nothing, and a group the person has left for nothing', async () => {
    const ann = await person('Carol');
    const dan = await person('Dan');
    // The owner of a group cannot leave it, so Carol joins a group Dan made, and leaves it at a balance of 0.
    const old = await createGroup(dan, 'Old', 'EUR');
    await join(dan, old, ann);
    await record(ann.token, old, {
      description: 'Cinema',
      amount: 1200,
      date: '2026-05-08',
      category: 'leisure',
      splitBetween: [ann.id],
    });
    const food = await createGroup(ann, 'Food', 'EUR');
    const dinner = await record(ann.token, food, {
      description: 'Dinner',
      amount: 900,
      date: '2026-05-09',
      category: 'food',
      splitBetween: [ann.id],
    });
    expect(await linesOf(ann.token)).toEqual(['2026-05 EUR food 900', '2026-05 EUR leisure 1200']);

    const deleted = await http.request('DELETE', `${api}/expenses/${dinner}`, { token: ann.token });
    expect(deleted.status).toBe(202);
    await outcome((deleted.body as Body).operationId as string, ann.token);
    expect(await linesOf(ann.token)).toEqual(['2026-05 EUR leisure 1200']);

    // Her balance in the old group is 0, so she may leave it; what she spent there is no longer hers to read.
    const left = await http.request('POST', `${api}/groups/${old}/leave`, { token: ann.token });
    if ((left.body as Body).operationId) await outcome((left.body as Body).operationId as string, ann.token);
    expect(await linesOf(ann.token)).toEqual([]);
  });

  it('answers 401 to a caller who is not signed in', async () => {
    const answer = await http.get(`${api}/accounts/me/insights`);
    expect(answer.status).toBe(401);
  });
});
