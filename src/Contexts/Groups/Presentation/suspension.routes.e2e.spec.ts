import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('suspension');

/** The administrator, as the server is started with it: the email is the one the sign-in gives the administrator's role (request 34). */
const ADMIN_EMAILS = 'Root@Example.com';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
/** The administrator, signed up and signed in once (request 34). */
let root: { token: string; id: string };

beforeAll(async () => {
  process.env.ADMIN_EMAILS = ADMIN_EMAILS;
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  root = await signedIn('Root@Example.com', 'Root');
});
afterAll(async () => {
  await app.stop();
  delete process.env.ADMIN_EMAILS;
});

const PASSWORD = 'a-good-password';
const PAST = '2026-01-15';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const suspend = (id: string, token: string) => http.request('PUT', `${api}/admin/accounts/${id}/suspension`, { token });
const reinstate = (id: string, token: string) =>
  http.request('DELETE', `${api}/admin/accounts/${id}/suspension`, { token });
const adminLog = (token: string) => http.request('GET', `${api}/admin/log`, { token });

const recordExpense = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body;

describe('suspending an account', () => {
  it('is for an administrator: anyone else signed in is refused by NotAllowed, and nothing changes', async () => {
    const bob = await signedIn('suspend-refused-bob@example.com', 'Bob');
    const cy = await signedIn('suspend-refused-cy@example.com', 'Cy');

    expect(await suspend(cy.id, bob.token)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect(await reinstate(cy.id, bob.token)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect((await adminLog(bob.token)).status).toBe(404);
    expect((await adminLog(root.token)).status).toBe(200);
  });

  it('refuses an expense, a recurring expense, a cash settlement and a netting its account starts, by AccountSuspended, and nothing in any group changes', async () => {
    const ann = await signedIn('suspend-ann@example.com', 'Ann');
    const bob = await signedIn('suspend-bob@example.com', 'Bob');
    const cy = await signedIn('suspend-cy@example.com', 'Cy');
    const groupId = await groupWith(ann, [bob, cy]);
    // Ann paid 300 for the three of them: Bob and Cy each owe her 100. Bob paid 60 for himself and Cy: Cy owes Bob 30.
    await recordExpense(groupId, ann.token, {
      description: 'Dinner',
      amount: 300,
      date: PAST,
      splitBetween: [ann.id, bob.id, cy.id],
    });
    await recordExpense(groupId, bob.token, {
      description: 'Taxi',
      amount: 60,
      date: PAST,
      splitBetween: [bob.id, cy.id],
    });
    const before = await balancesOf(groupId, ann.token);

    expect((await suspend(bob.id, root.token)).status).toBeLessThan(300);

    expect(
      await recordExpense(groupId, bob.token, {
        description: 'Coffee',
        amount: 10,
        date: PAST,
        splitBetween: [bob.id],
      }),
    ).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
    expect(
      await http.request('POST', `${api}/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 900, startsOn: '2026-11-01', splitBetween: [bob.id] },
        token: bob.token,
      }),
    ).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: cy.id, amount: 30 },
        token: bob.token,
      }),
    ).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
    expect(
      await http.request('POST', `${api}/nettings`, { body: { with: ann.id, currency: 'EUR' }, token: bob.token }),
    ).toMatchObject({
      status: 422,
      body: { type: 'AccountSuspended' },
    });

    // Refused changes write nothing in the group: its balances are what they were.
    expect(await balancesOf(groupId, ann.token)).toEqual(before);
  });

  it('leaves what the suspended account still can, and the others of its groups go on', async () => {
    const ann = await signedIn('still-ann@example.com', 'Ann');
    const bob = await signedIn('still-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    const expense = await recordExpense(groupId, ann.token, {
      description: 'Groceries',
      amount: 100,
      date: PAST,
      splitBetween: [ann.id, bob.id],
    });
    await suspend(bob.id, root.token);

    // Bob still signs in, reads, and reads the expense he is in.
    expect((await http.request('GET', `${api}/accounts/me`, { token: bob.token })).status).toBe(200);
    expect(
      (await http.request('GET', `${api}/expenses/${(expense.body as { id: string }).id}`, { token: bob.token }))
        .status,
    ).toBe(200);
    // Ann may still put Bob in a split, and record his payment to her in cash.
    expect(
      (
        await recordExpense(groupId, ann.token, {
          description: 'Bread',
          amount: 20,
          date: PAST,
          splitBetween: [ann.id, bob.id],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
          body: { from: bob.id, amount: 10 },
          token: ann.token,
        })
      ).status,
    ).toBe(201);
  });

  it('is undone by reinstating, after which the account records again; each change is one entry of the log, and no change is none', async () => {
    const ann = await signedIn('logged-ann@example.com', 'Ann');
    const bob = await signedIn('logged-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);

    await suspend(bob.id, root.token);
    await suspend(bob.id, root.token);
    expect(
      await recordExpense(groupId, bob.token, { description: 'Tea', amount: 5, date: PAST, splitBetween: [bob.id] }),
    ).toMatchObject({
      status: 422,
      body: { type: 'AccountSuspended' },
    });
    await reinstate(bob.id, root.token);
    await reinstate(bob.id, root.token);
    expect(
      (await recordExpense(groupId, bob.token, { description: 'Tea', amount: 5, date: PAST, splitBetween: [bob.id] }))
        .status,
    ).toBe(201);

    const entries = (await adminLog(root.token)).body as Array<{ action: string; subjectId: string; by: string }>;
    const mine = entries.filter(entry => entry.subjectId === bob.id);
    expect(mine.map(entry => entry.action)).toEqual(['suspended', 'reinstated']);
    expect(mine.every(entry => entry.by === root.id)).toBe(true);
  });
});

describe('Groups → Ledger', () => {
  it('refuses, by AccountSuspended in Ledger, an expense the account Groups suspended starts, by the id its sign-up answered', async () => {
    const ann = await signedIn('ledger-rel-ann@example.com', 'Ann');
    const bob = await signedIn('ledger-rel-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);

    expect((await suspend(bob.id, root.token)).status).toBeLessThan(300);

    expect(
      await recordExpense(groupId, bob.token, { description: 'Snack', amount: 4, date: PAST, splitBetween: [bob.id] }),
    ).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
    // Ledger reads the same member by that id, and nothing of the refused expense is in its balances.
    const balances = (await balancesOf(groupId, ann.token)) as Array<{ memberId: string; balance: number }>;
    expect(balances.find(each => each.memberId === bob.id)).toEqual({ memberId: bob.id, balance: 0 });
    await reinstate(bob.id, root.token);
  });
});

describe('Groups → Settlements', () => {
  it('reads, in Settlements, the cash settlement a reinstated account records by the id its sign-up answered', async () => {
    const ann = await signedIn('settle-rel-ann@example.com', 'Ann');
    const bob = await signedIn('settle-rel-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await recordExpense(groupId, ann.token, {
      description: 'Lunch',
      amount: 100,
      date: PAST,
      splitBetween: [ann.id, bob.id],
    });

    await suspend(bob.id, root.token);
    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: bob.id, amount: 10 },
        token: ann.token,
      }),
    ).toMatchObject({ status: 201 });
    await reinstate(bob.id, root.token);

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 10 },
      token: ann.token,
    });
    const read = await http.request('GET', `${api}/settlements/${(recorded.body as { id: string }).id}`, {
      token: ann.token,
    });
    expect(read.body).toMatchObject({ from: bob.id, to: ann.id, method: 'cash', amount: 10 });
  });
});
