import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
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
  process.env.DATABASE_URL = await freshDatabaseUrl();
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

  it('lets a member leave whatever their balance, which passes to the owner in the same step', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    await record(
      groupId,
      { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
      owner.token,
    );

    // Grace owes 50 (her balance is -50), the owner is owed 50: when Grace leaves, the 50 she owes passes to the owner.
    expect((await leave(groupId, grace.token)).status).toBe(204);

    const balances = (await balancesOf(groupId, owner.token)).body as { memberId: string; balance: number }[];
    expect(balances).toEqual([{ memberId: owner.id, balance: 0 }]);
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

describe('a leave and an expense at the same moment (request 20)', () => {
  it('counts the expense in what passes or refuses it, and the balances add up to 0 either way', async () => {
    for (let round = 0; round < 5; round += 1) {
      const owner = await signedInPerson('Owner');
      const grace = await signedInPerson('Grace');
      const linus = await signedInPerson('Linus');
      const groupId = await groupWith(owner, [grace, linus]);

      const [left, expense] = await Promise.all([
        leave(groupId, grace.token),
        record(
          groupId,
          { description: 'Taxi', amount: 90, date: '2020-01-15', splitBetween: [owner.id, grace.id, linus.id] },
          owner.token,
        ),
      ]);

      expect(left.status).toBe(204);
      const balances = (await balancesOf(groupId, owner.token)).body as { memberId: string; balance: number }[];
      expect(balances.map(balance => balance.memberId)).toEqual([owner.id, linus.id]);
      expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
      if (expense.status < 300) {
        // Recorded before the leave: Grace's 30 of the split passed to the owner, who paid 90 and is owed 60 less that 30.
        expect(balances).toEqual([
          { memberId: owner.id, balance: 30 },
          { memberId: linus.id, balance: -30 },
        ]);
      } else {
        // Recorded after the leave: refused, because Grace was no longer a member; nothing was owed, so nothing passed.
        expect(expense.status).toBe(400);
        expect(balances).toEqual([
          { memberId: owner.id, balance: 0 },
          { memberId: linus.id, balance: 0 },
        ]);
      }
    }
  });
});

describe('Groups → Ledger', () => {
  it('finds, through Ledger, the group made through Groups by the id its creation answered, and passes a leaving member balance to the owner', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: owner.token,
    });
    const { id: groupId } = created.body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    await record(
      groupId,
      { description: 'Taxi', amount: 80, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
      owner.token,
    );

    const before = (await balancesOf(groupId, owner.token)).body as { memberId: string; balance: number }[];
    expect(before.find(balance => balance.memberId === grace.id)?.balance).toBe(-40);

    expect((await leave(groupId, grace.token)).status).toBe(204);
    expect((await balancesOf(groupId, owner.token)).body).toEqual([{ memberId: owner.id, balance: 0 }]);
  });
});

describe('Ledger → Groups', () => {
  it('reads, from Ledger, the balances an archive is decided on: an unsettled expense refuses it, and once settled the owner archives', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    await record(
      groupId,
      { description: 'Taxi', amount: 80, date: '2020-01-15', splitBetween: [owner.id, grace.id] },
      owner.token,
    );

    const refused = await http.request('POST', `${api}/groups/${groupId}/archive`, { token: owner.token });
    expect(refused.body).toMatchObject({ type: 'BalancesNotSettled' });

    const settled = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 40 },
      token: owner.token,
    });
    expect(settled.status).toBe(201);
    expect((await http.request('POST', `${api}/groups/${groupId}/archive`, { token: owner.token })).status).toBe(204);
  });

  it('reads, from Ledger, the balance an expense recorded in it gives a member, and passes it to the owner when the member leaves', async () => {
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
    const before = (await balancesOf(groupId, owner.token)).body as { memberId: string; balance: number }[];
    expect(before.find(balance => balance.memberId === grace.id)?.balance).toBe(-40);

    expect((await leave(groupId, grace.token)).status).toBe(204);

    const after = (await balancesOf(groupId, owner.token)).body as { memberId: string; balance: number }[];
    expect(after).toEqual([{ memberId: owner.id, balance: 0 }]);
    const members = (await membersOf(groupId, owner.token)).body as { memberId: string }[];
    expect(members.map(member => member.memberId)).toEqual([owner.id]);
  });
});
