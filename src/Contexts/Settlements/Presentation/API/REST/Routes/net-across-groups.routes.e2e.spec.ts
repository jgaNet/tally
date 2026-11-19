import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'net-across-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
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
  const email = `net-across-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in a currency, and answers its id. */
async function createGroup(owner: { token: string }, name: string, currency: string) {
  const answer = await http.request('POST', `${api}/groups`, { body: { name, currency }, token: owner.token });
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

/** Records an expense, split equally between the given members, and follows it to its outcome. */
async function recordSplit(token: string, groupId: string, amount: number, between: string[]) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Shared', amount, date: serverToday, splitBetween: between },
    token,
  });
  const done = await outcome((answer.body as Body).operationId as string, token);
  expect(done.body.status).toBe('SUCCESS');
}

/** Asks for a netting as one of the two people does, and follows it to its outcome. */
async function net(token: string, withId: string, currency: string) {
  const answer = await http.request('POST', `${api}/nettings`, { body: { with: withId, currency }, token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

describe('Settlements: what two people owe each other across their groups is netted as settlements that count at once', () => {
  it('nets the smaller total across the groups they share, in the order they were created, and reads it back', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const flat = await createGroup(bob, 'Flat', 'EUR');
    await join(flat, bob, ann);
    const trip = await createGroup(bob, 'Trip', 'EUR');
    await join(trip, bob, ann);
    const club = await createGroup(ann, 'Club', 'EUR');
    await join(club, ann, bob);
    const abroad = await createGroup(bob, 'Abroad', 'USD');
    await join(abroad, bob, ann);

    // Ann owes Bob 300 in the flat and 200 in the trip; Bob owes Ann 400 in the club.
    await recordSplit(bob.token, flat, 600, [ann.id, bob.id]);
    await recordSplit(bob.token, trip, 400, [ann.id, bob.id]);
    await recordSplit(ann.token, club, 800, [ann.id, bob.id]);

    const answered = await net(ann.token, bob.id, 'EUR');
    expect(answered.status).toBe('SUCCESS');
    const id = (answered.body.result as { id: string }).id;

    const read = await http.get(`${api}/nettings/${id}`, { token: ann.token });
    expect(read.status).toBe(200);
    const netting = read.body as { settlements: string[]; amount: number };
    expect(netting).toEqual({
      id,
      by: ann.id,
      with: bob.id,
      currency: 'EUR',
      amount: 400,
      settlements: [expect.any(String), expect.any(String), expect.any(String)],
    });

    const made: { amount: number; method: string; status: string }[] = [];
    for (const settlementId of netting.settlements) {
      const settlement = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
      made.push(settlement.body as (typeof made)[number]);
    }
    expect(made.map(s => [s.amount, s.method, s.status])).toEqual([
      [300, 'net', 'paid'],
      [100, 'net', 'paid'],
      [400, 'net', 'paid'],
    ]);
  });

  it('refuses a second netting with nothing left to net, and nets for no one else', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const carl = await person('Carl');
    const flat = await createGroup(bob, 'Flat', 'EUR');
    await join(flat, bob, ann);
    const club = await createGroup(ann, 'Club', 'EUR');
    await join(club, ann, bob);
    // Ann owes Bob 300 in the flat, and Bob owes Ann 400 in the club: 300 is netted, and nothing is left after it.
    await recordSplit(bob.token, flat, 600, [ann.id, bob.id]);
    await recordSplit(ann.token, club, 800, [ann.id, bob.id]);

    const first = await net(ann.token, bob.id, 'EUR');
    expect(first.status).toBe('SUCCESS');
    expect((first.body.result as { id: string }).id).toBeDefined();
    const second = await net(ann.token, bob.id, 'EUR');
    expect(second.status).toBe('ERROR');
    expect((second.body.error as { type: string }).type).toBe('NothingToNet');

    const id = (first.body.result as { id: string }).id;
    const seen = await http.get(`${api}/nettings/${id}`, { token: carl.token });
    expect(seen.status).toBe(404);
  });

  it("refuses a netting with oneself, and one in a currency that is not Tally's", async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');

    const self = await net(ann.token, ann.id, 'EUR');
    expect(self.status).toBe('ERROR');
    expect((self.body.error as { type: string }).type).toBe('NettingWithOneself');

    const unknown = await net(ann.token, bob.id, 'XYZ');
    expect(unknown.status).toBe('ERROR');
    expect((unknown.body.error as { type: string }).type).toBe('UnknownNettingCurrency');
  });
});
