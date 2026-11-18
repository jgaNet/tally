import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Archiving a group, over HTTP (request 27): the owner archives it once every balance is 0 and no payment waits at the provider; an
 * archived group refuses every change by the one name `GroupArchived` and changes nothing, and its members still read it. The answers
 * are held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-archive-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person, with a fresh email, and their token. */
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
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

const archive = (groupId: string, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/archive`, { token });
const readGroup = (groupId: string, token?: string) => http.request('GET', `${api}/groups/${groupId}`, { token });
const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const expenseOf = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const balancesOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

/** The error's rule, as the answer names it. */
const refusedBy = (answer: { body: unknown }) => (answer.body as { type: string }).type;

describe('archiving a group', () => {
  it('lets the owner archive it once every balance is 0, and shows when, to every member', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    expect((await readGroup(groupId, grace.token)).body as object).not.toHaveProperty('archivedAt');
    await record(
      groupId,
      { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
      owner.token,
    );
    await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 50 },
      token: owner.token,
    });

    expect((await archive(groupId, owner.token)).status).toBe(204);

    const asGrace = (await readGroup(groupId, grace.token)).body as { archivedAt?: string };
    expect(typeof asGrace.archivedAt).toBe('string');
    const mine = (await http.request('GET', `${api}/groups/mine`, { token: grace.token })).body as {
      archivedAt?: string;
    }[];
    expect(mine).toHaveLength(1);
    expect(typeof mine[0].archivedAt).toBe('string');
  });

  it('refuses the archive to a member who is not the owner, and to the owner while a balance is not 0, changing nothing', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    await record(
      groupId,
      { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
      owner.token,
    );

    expect(refusedBy(await archive(groupId, grace.token))).toBe('NotAllowed');
    expect(refusedBy(await archive(groupId, owner.token))).toBe('BalancesNotSettled');

    expect((await readGroup(groupId, owner.token)).body as object).not.toHaveProperty('archivedAt');
  });

  it('refuses every change in an archived group by the one name, changes nothing, and still lets its members read it', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(owner, [grace]);
    const expenseId = (
      (
        await record(
          groupId,
          { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
          owner.token,
        )
      ).body as { id: string }
    ).id;
    await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 50 },
      token: owner.token,
    });
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token }))
      .body as { id: string };
    expect((await archive(groupId, owner.token)).status).toBe(204);
    const { version } = (await expenseOf(expenseId, owner.token)).body as { version: number };

    const changes = [
      await record(
        groupId,
        { description: 'Late', amount: 10, date: '2020-01-16', splitBetween: [owner.id, grace.id] },
        owner.token,
      ),
      await http.request('PUT', `${api}/expenses/${expenseId}`, {
        body: { description: 'Dinner', amount: 90, date: '2020-01-15', splitBetween: [owner.id, grace.id], version },
        token: owner.token,
      }),
      await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: owner.token }),
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: grace.id, amount: 1 },
        token: owner.token,
      }),
      await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
        body: { to: owner.id, amount: 10 },
        token: grace.token,
      }),
      await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token }),
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: linus.token }),
      await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token }),
      await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
        body: { amount: 100 },
        token: owner.token,
      }),
      await http.request('POST', `${api}/groups/${groupId}/templates`, {
        body: { name: 'Flat', splitBetween: [owner.id, grace.id] },
        token: owner.token,
      }),
      await http.request('POST', `${api}/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 900, startsOn: '2020-02-01', splitBetween: [owner.id, grace.id] },
        token: owner.token,
      }),
      await archive(groupId, owner.token),
    ];
    for (const answer of changes) expect(refusedBy(answer)).toBe('GroupArchived');

    // Nothing changed: the balances still add up to 0 at 0 each, the expense is as it was, and the members are the same.
    expect(
      ((await balancesOf(groupId, owner.token)).body as { balance: number }[]).map(entry => entry.balance),
    ).toEqual([0, 0]);
    expect(((await expenseOf(expenseId, owner.token)).body as { amount: number }).amount).toBe(100);
    expect(
      ((await http.request('GET', `${api}/groups/${groupId}/members`, { token: owner.token })).body as unknown[])
        .length,
    ).toBe(2);
    expect(
      ((await http.request('GET', `${api}/groups/${groupId}/budgets`, { token: owner.token })).body as unknown[])
        .length,
    ).toBe(0);

    // Reads go on as before.
    expect((await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: grace.token })).status).toBe(200);
    expect((await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: grace.token })).status).toBe(
      200,
    );
    expect((await http.request('GET', `${api}/groups/${groupId}/templates`, { token: grace.token })).status).toBe(200);
    expect((await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: grace.token })).status).toBe(200);
  });
});
