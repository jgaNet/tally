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
  // The server's date, read from an operation it answers: the application has one clock.
  const probeSignUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'archive-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((probeSignUp.body as Body).operationId as string);
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

/** Asks for a command, and follows it to its outcome: the operation's body, or the answer when it is not a 202. */
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

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-archive-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group the owner made, and answers its id. */
async function createGroup(owner: { token: string }) {
  const { done } = await send('POST', '/groups', owner.token, { name: 'Trip', currency: 'EUR' });
  return (done as { result: { id: string } }).result.id;
}

/** The owner invites the joiner, who accepts: the joiner is a member from then on. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const { done } = await send('POST', `/groups/${groupId}/invitations`, owner.token);
  const invitationId = (done as { result: { id: string } }).result.id;
  await send('POST', `/invitations/${invitationId}/accept`, joiner.token);
  return invitationId;
}

/** The owner records an expense the two of them share equally: the other one owes half of it. */
async function shareExpense(groupId: string, owner: { token: string; id: string }, other: { id: string }) {
  const { done } = await send('POST', `/groups/${groupId}/expenses`, owner.token, {
    description: 'Dinner',
    amount: 100,
    date: serverToday,
    splitBetween: [owner.id, other.id],
  });
  return (done as { result: { id: string } }).result.id;
}

describe('archiving a group (request 27)', () => {
  it('the owner archives a group whose balances are 0: it reads archivedAt, and its members still read it', async () => {
    const owner = await person('Owner');
    const member = await person('Member');
    const groupId = await createGroup(owner);
    await join(groupId, owner, member);

    const archived = await send('POST', `/groups/${groupId}/archive`, owner.token);
    expect(refusedBy(archived.done)).toBeUndefined();
    expect(archived.done).toMatchObject({ status: 'SUCCESS' });

    const read = await http.get(`${api}/groups/${groupId}`, { token: member.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: groupId, name: 'Trip', currency: 'EUR', ownerId: owner.id });
    expect(String((read.body as Body).archivedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const mine = await http.get(`${api}/groups/mine`, { token: member.token });
    expect(mine.body as Body[]).toEqual([
      expect.objectContaining({ id: groupId, archivedAt: (read.body as Body).archivedAt }),
    ]);

    const members = await http.get(`${api}/groups/${groupId}/members`, { token: member.token });
    expect(members.status).toBe(200);
    expect((members.body as Body[]).map(entry => entry.memberId)).toEqual([owner.id, member.id]);
  });

  it('an open group reads no archivedAt at all', async () => {
    const owner = await person('Open');
    const groupId = await createGroup(owner);
    const read = await http.get(`${api}/groups/${groupId}`, { token: owner.token });
    expect(read.body).not.toHaveProperty('archivedAt');
  });

  it('refuses a member who is not the owner, and an owner with a balance not 0, and archives nothing', async () => {
    const owner = await person('Owed');
    const member = await person('Debtor');
    const groupId = await createGroup(owner);
    await join(groupId, owner, member);
    await shareExpense(groupId, owner, member);

    const byMember = await send('POST', `/groups/${groupId}/archive`, member.token);
    expect(refusedBy(byMember.done)).toBe('OnlyTheOwnerArchives');

    const unsettled = await send('POST', `/groups/${groupId}/archive`, owner.token);
    expect(refusedBy(unsettled.done)).toBe('GroupNotSettled');

    const read = await http.get(`${api}/groups/${groupId}`, { token: owner.token });
    expect(read.body).not.toHaveProperty('archivedAt');
  });

  it('refuses every change in an archived group by GroupArchived, changes nothing, and reads as before', async () => {
    const owner = await person('Closed');
    const member = await person('Settled');
    const stranger = await person('Stranger');
    const groupId = await createGroup(owner);
    await join(groupId, owner, member);
    const expenseId = await shareExpense(groupId, owner, member);
    const pending = await send('POST', `/groups/${groupId}/invitations`, owner.token);
    const openInvitation = (pending.done as { result: { id: string } }).result.id;
    // The member's share is settled in cash, recorded by the owner who is paid: the balances go back to 0.
    const settled = await send('POST', `/groups/${groupId}/settlements/cash`, owner.token, {
      from: member.id,
      amount: 50,
    });
    expect(settled.done).toMatchObject({ status: 'SUCCESS' });

    const archived = await send('POST', `/groups/${groupId}/archive`, owner.token);
    expect(archived.done).toMatchObject({ status: 'SUCCESS' });

    const expense = await http.get(`${api}/expenses/${expenseId}`, { token: owner.token });
    const version = (expense.body as { version: number }).version;
    const changes: [string, () => Promise<{ done: Body | undefined }>][] = [
      [
        'record an expense',
        () =>
          send('POST', `/groups/${groupId}/expenses`, owner.token, {
            description: 'Late',
            amount: 10,
            date: serverToday,
            splitBetween: [owner.id, member.id],
          }),
      ],
      [
        'edit an expense',
        () =>
          send('PUT', `/expenses/${expenseId}`, owner.token, {
            description: 'Dinner',
            amount: 90,
            date: serverToday,
            version,
            splitBetween: [owner.id, member.id],
          }),
      ],
      ['delete an expense', () => send('DELETE', `/expenses/${expenseId}`, owner.token)],
      ['set a budget', () => send('PUT', `/groups/${groupId}/budgets/groceries`, owner.token, { amount: 100 })],
      [
        'set up a recurring expense',
        () =>
          send('POST', `/groups/${groupId}/recurring`, owner.token, {
            description: 'Rent',
            amount: 50,
            startsOn: '2026-01-05',
            splitBetween: [owner.id, member.id],
          }),
      ],
      [
        'save a template',
        () =>
          send('POST', `/groups/${groupId}/templates`, owner.token, {
            name: 'Flat',
            splitBetween: [owner.id, member.id],
          }),
      ],
      [
        'record a cash settlement',
        () => send('POST', `/groups/${groupId}/settlements/cash`, owner.token, { from: member.id, amount: 1 }),
      ],
      [
        'ask for a provider settlement',
        () => send('POST', `/groups/${groupId}/settlements/provider`, member.token, { to: owner.id, amount: 1 }),
      ],
      ['archive it again', () => send('POST', `/groups/${groupId}/archive`, owner.token)],
      ['create an invitation', () => send('POST', `/groups/${groupId}/invitations`, owner.token)],
      ['accept an invitation', () => send('POST', `/invitations/${openInvitation}/accept`, stranger.token)],
      ['leave the group', () => send('POST', `/groups/${groupId}/leave`, member.token)],
    ];
    for (const [what, change] of changes) {
      const { done } = await change();
      expect({ what, refusedBy: refusedBy(done) }).toEqual({ what, refusedBy: 'GroupArchived' });
    }

    // Nothing changed: the expense is still there, at its version, and the group is still archived and read as before.
    const again = await http.get(`${api}/expenses/${expenseId}`, { token: owner.token });
    expect(again.body).toMatchObject({ id: expenseId, version, amount: 100 });
    const expenses = await http.get(`${api}/groups/${groupId}/expenses`, { token: owner.token });
    expect(expenses.body as Body[]).toHaveLength(1);
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: member.token });
    expect(balances.status).toBe(200);
    const group = await http.get(`${api}/groups/${groupId}`, { token: member.token });
    expect(group.body).toHaveProperty('archivedAt');
    const budgets = await http.get(`${api}/groups/${groupId}/budgets`, { token: owner.token });
    expect(budgets.body as Body[]).toEqual([]);
  }, 60_000);
});
