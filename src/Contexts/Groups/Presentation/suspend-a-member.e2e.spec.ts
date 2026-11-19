import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 34 over HTTP: an administrator suspends an account and reinstates it. While it is suspended, the expenses, recurring expenses, cash
 * settlements, provider payments and nettings it starts are refused by the one name `AccountSuspended` and change nothing; everything else it
 * does goes on, and so do the others of its groups. Nothing is written in any group, and each suspension and reinstatement is an entry of the
 * administrators' log. The answers are held to the API `api/` gives, through `apiClient()`.
 */
const ADMIN_EMAIL = 'root@example.org';
const PASSWORD = 'a long password';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let admin: { token: string; id: string };

beforeAll(async () => {
  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.ADMIN_EMAILS = ADMIN_EMAIL.toUpperCase();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  admin = await signedIn(ADMIN_EMAIL, 'Root');
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person with a fresh email (or the given one), and their token and id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const address = email.includes('@') ? email : `${email.toLowerCase()}${accountCount}@example.org`;
  const created = await http.request('POST', `${api}/accounts`, { body: { email: address, password: PASSWORD, name } });
  const { token } = (
    await http.request('POST', `${api}/accounts/login`, { body: { email: address, password: PASSWORD } })
  ).body as { token: string };
  return { token, id: (created.body as { id: string }).id };
}

/** A group owned by `owner`, which each of `others` has joined through an invitation, in that order. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const suspend = (accountId: string, token?: string) =>
  http.request('PUT', `${api}/admin/accounts/${accountId}/suspension`, { token });
const reinstate = (accountId: string, token?: string) =>
  http.request('DELETE', `${api}/admin/accounts/${accountId}/suspension`, { token });
const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const expensesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token })).body as { id: string; version: number }[];
const balancesOf = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });
const cashFrom = (groupId: string, from: string, amount: number, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body: { from, amount }, token });
const askProvider = (groupId: string, to: string, amount: number, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body: { to, amount }, token });
const netWith = (other: string, token: string) =>
  http.request('POST', `${api}/nettings`, { body: { with: other, currency: 'EUR' }, token });
const setUpRecurring = (groupId: string, groupMemberId: string, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/recurring`, {
    body: { description: 'Rent', amount: 100, startsOn: '2026-12-05', splitBetween: [groupMemberId] },
    token,
  });

/** The error's rule, as the answer names it. */
const refusedBy = (answer: { body: unknown }) => (answer.body as { type: string }).type;

describe('suspending a member', () => {
  it('lets only an administrator suspend or reinstate an account, and refuses anyone else', async () => {
    const ann = await signedIn('Ann', 'Ann');
    const bob = await signedIn('Bob', 'Bob');

    expect((await suspend(ann.id)).status).toBe(401);
    const asBob = await suspend(ann.id, bob.token);
    expect(asBob.status).toBe(403);
    expect(refusedBy(asBob)).toBe('NotAllowed');
    expect((await suspend('no-such-account', admin.token)).status).toBe(404);
  });

  it('refuses the five things a suspended account starts by the one name, changes nothing, and lets the rest go on', async () => {
    const ann = await signedIn('Ann', 'Ann');
    const bob = await signedIn('Bob', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    // Bob pays 100, split between Ann and him: Ann owes Bob 50, and Bob is owed it.
    const earlier = (
      await record(
        groupId,
        { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [ann.id, bob.id] },
        bob.token,
      )
    ).body as { id: string };
    const before = JSON.stringify((await balancesOf(groupId, ann.token)).body);
    const expensesBefore = (await expensesOf(groupId, ann.token)).length;

    expect((await suspend(ann.id, admin.token)).status).toBe(204);

    // Refused by the one name, each, and nothing written.
    const refusals = [
      await record(
        groupId,
        { description: 'Taxi', amount: 10, date: '2020-01-16', splitBetween: [ann.id, bob.id] },
        ann.token,
      ),
      await setUpRecurring(groupId, ann.id, ann.token),
      await cashFrom(groupId, bob.id, 50, ann.token),
      await askProvider(groupId, bob.id, 50, ann.token),
      await netWith(bob.id, ann.token),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(400);
      expect(refusedBy(refusal)).toBe('AccountSuspended');
    }
    expect(JSON.stringify((await balancesOf(groupId, ann.token)).body)).toBe(before);
    expect(await expensesOf(groupId, ann.token)).toHaveLength(expensesBefore);

    // What it still can: reading the group, and editing an expense it can.
    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: ann.token })).status).toBe(200);
    const { version } = (await http.request('GET', `${api}/expenses/${earlier.id}`, { token: ann.token })).body as {
      version: number;
    };
    expect(
      (
        await http.request('PUT', `${api}/expenses/${earlier.id}`, {
          body: { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [ann.id, bob.id], version },
          token: ann.token,
        })
      ).status,
    ).toBe(204);

    // The other members go on: Bob records a cash settlement from Ann, to him, and records an expense split with Ann.
    expect((await cashFrom(groupId, ann.id, 50, bob.token)).status).toBe(201);
    expect(
      (
        await record(
          groupId,
          { description: 'Bus', amount: 20, date: '2020-01-17', splitBetween: [ann.id, bob.id] },
          bob.token,
        )
      ).status,
    ).toBe(201);
  });

  it('reinstates the account, which may then do what it could, and logs each change once', async () => {
    const ann = await signedIn('Ann', 'Ann');
    const bob = await signedIn('Bob', 'Bob');
    const groupId = await groupWith(bob, [ann]);

    expect((await suspend(ann.id, admin.token)).status).toBe(204);
    expect((await suspend(ann.id, admin.token)).status).toBe(204);
    expect(
      refusedBy(
        await record(
          groupId,
          { description: 'Taxi', amount: 10, date: '2020-01-16', splitBetween: [ann.id, bob.id] },
          ann.token,
        ),
      ),
    ).toBe('AccountSuspended');

    expect((await reinstate(ann.id, admin.token)).status).toBe(204);
    expect((await reinstate(ann.id, admin.token)).status).toBe(204);
    expect(
      (
        await record(
          groupId,
          { description: 'Taxi', amount: 10, date: '2020-01-16', splitBetween: [ann.id, bob.id] },
          ann.token,
        )
      ).status,
    ).toBe(201);

    const log = (await http.request('GET', `${api}/admin/log`, { token: admin.token })).body as {
      action: string;
      subjectId: string;
      by: string;
    }[];
    const ofAnn = log.filter(entry => entry.subjectId === ann.id).map(entry => entry.action);
    expect(ofAnn).toEqual(['suspended', 'reinstated']);
    expect(log.filter(entry => entry.subjectId === ann.id).every(entry => entry.by === admin.id)).toBe(true);
  });

  it("keeps the administrators' log to administrators", async () => {
    const bob = await signedIn('Bob', 'Bob');
    expect((await http.request('GET', `${api}/admin/log`, { token: bob.token })).status).toBe(404);
  });
});
