import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Leaving a group, over HTTP (feature 9): the owner stays, a member leaves once their balance is 0, and what concerns them
 * stays as it was. Groups, invitations and expenses are made through their own routes; the answers are held to the API
 * `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-leave-')), 'tally.sqlite');
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

const leave = (groupId: string, token: string) => http.request('POST', `${api}/groups/${groupId}/leave`, { token });
const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const expenseOf = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const editExpense = (id: string, body: Record<string, unknown>, token?: string) =>
  http.request('PUT', `${api}/expenses/${id}`, { body, token });
const membersOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members`, { token });
const balancesOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

describe('leaving a group', () => {
  it('refuses the owner, who cannot leave the group they created', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);

    const answer = await leave(groupId, owner.token);

    expect(answer.status).not.toBe(204);
    expect((answer.body as { type: string }).type).toBe('OwnerCannotLeave');
    expect((await membersOf(groupId, owner.token)).body).toHaveLength(2);
  });

  it('refuses a member whose balance is not 0, and lets them leave once it is', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    await record(
      groupId,
      { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
      owner.token,
    );

    const refused = await leave(groupId, grace.token);
    expect((refused.body as { type: string }).type).toBe('BalanceNotZero');

    // Grace pays 100 split with the owner: she paid 100 and owes 50, so her balance goes from -50 to 0, the owner's from 50 to 0.
    await record(
      groupId,
      { description: 'Settle', amount: 100, date: '2020-01-16', splitBetween: [grace.id, owner.id] },
      grace.token,
    );
    expect((await leave(groupId, grace.token)).status).toBe(204);
  });

  it('takes the member out: the group is gone for them, and they are not among its members', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(owner, [grace, linus]);

    expect((await leave(groupId, grace.token)).status).toBe(204);

    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: grace.token })).status).toBe(404);
    expect(((await http.request('GET', `${api}/groups/mine`, { token: grace.token })).body as unknown[]).length).toBe(
      0,
    );
    const members = (await membersOf(groupId, owner.token)).body as { memberId: string }[];
    expect(members.map(member => member.memberId)).toEqual([owner.id, linus.id]);
    expect(
      (
        await record(
          groupId,
          { description: 'Late', amount: 10, date: '2020-01-17', splitBetween: [grace.id, owner.id] },
          owner.token,
        )
      ).status,
    ).toBe(400);
  });

  it('keeps an expense of a former member as it was: it cannot be changed, and their statement stays readable', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    const { id } = (
      await record(
        groupId,
        { description: 'Taxi', amount: 40, date: '2020-01-15', splitBetween: [grace.id] },
        grace.token,
      )
    ).body as { id: string };
    expect((await leave(groupId, grace.token)).status).toBe(204);

    const { version } = (await expenseOf(id, owner.token)).body as { version: number };
    const edit = await editExpense(
      id,
      { description: 'Taxi', amount: 40, date: '2020-01-15', splitBetween: [owner.id], version },
      owner.token,
    );
    expect((edit.body as { type: string }).type).toBe('ExpenseHasFormerMember');

    const statement = await http.request('GET', `${api}/groups/${groupId}/members/${grace.id}/statement`, {
      token: owner.token,
    });
    expect(statement.status).toBe(200);
    expect((statement.body as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('lets someone who left join again: they are last among the members, at a balance of 0', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(owner, [grace, linus]);
    expect((await leave(groupId, grace.token)).status).toBe(204);

    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token }))
      .body as {
      id: string;
    };
    expect(
      (await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token })).status,
    ).toBe(204);

    const members = (await membersOf(groupId, owner.token)).body as { memberId: string }[];
    expect(members.map(member => member.memberId)).toEqual([owner.id, linus.id, grace.id]);
    const balances = (await balancesOf(groupId, owner.token)).body as { memberId: string; balance: number }[];
    expect(balances.find(balance => balance.memberId === grace.id)?.balance).toBe(0);
  });
});

describe('Ledger → Groups', () => {
  it('reads, from Ledger, the balance an expense recorded in it gives a member, and refuses that member to leave until it is 0', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    const { id: expenseId } = (
      await record(
        groupId,
        { description: 'Taxi', amount: 80, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
        owner.token,
      )
    ).body as { id: string };
    expect(expenseId).toEqual(expect.any(String));

    const refused = await leave(groupId, grace.token);
    expect((refused.body as { type: string }).type).toBe('BalanceNotZero');
    const members = (await membersOf(groupId, owner.token)).body as { memberId: string }[];
    expect(members.map(member => member.memberId)).toEqual([owner.id, grace.id]);
  });
});
