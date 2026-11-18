import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The group's expenses and a member's statement, over HTTP (request 8): the expenses latest date first and, on a date, most
 * recently recorded first, an edit not moving an expense in that order; a statement earliest first, with the balance after
 * each entry, which ends at the group's balance of the member; and the answers for those who are not members. Groups and
 * expenses are made through their own routes; the answers are held to the API `api/` gives, through `apiClient()`.
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

const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const expenseOf = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const groupExpenses = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/expenses`, { token });
const statementOf = (groupId: string, memberId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement`, { token });
const balancesOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

/** The id of a recorded expense, from its answer. */
const idOf = (answer: { body: unknown }) => (answer.body as { id: string }).id;

describe('a group’s expenses', () => {
  it('lists the latest date first, and on the same date the most recently recorded first', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const first = idOf(
      await record(
        groupId,
        { description: 'Rent', amount: 1000, date: '2025-03-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );
    const second = idOf(
      await record(
        groupId,
        { description: 'Gas', amount: 400, date: '2025-03-05', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );
    const third = idOf(
      await record(
        groupId,
        { description: 'Milk', amount: 200, date: '2025-03-05', splitBetween: [ada.id, grace.id] },
        grace.token,
      ),
    );

    const answer = await groupExpenses(groupId, grace.token);
    expect(answer.status).toBe(200);
    expect((answer.body as { id: string }[]).map(expense => expense.id)).toEqual([third, second, first]);
  });

  it('reads each expense as GET /v1/expenses/{id} reads it', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const id = idOf(
      await record(
        groupId,
        { description: 'Rent', amount: 1001, date: '2025-02-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );

    const listed = (await groupExpenses(groupId, ada.token)).body as unknown[];
    expect(listed).toEqual([(await expenseOf(id, ada.token)).body]);
  });

  it('does not move an edited expense: a recording order is kept by the edit', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const older = idOf(
      await record(
        groupId,
        { description: 'Old', amount: 100, date: '2025-04-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );
    const newer = idOf(
      await record(
        groupId,
        { description: 'New', amount: 100, date: '2025-04-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );

    const read = (await expenseOf(older, ada.token)).body as Record<string, unknown>;
    const edit = await http.request('PUT', `${api}/expenses/${older}`, {
      body: {
        description: 'Old, edited',
        amount: 100,
        date: '2025-04-01',
        splitBetween: [ada.id, grace.id],
        version: read.version,
      },
      token: ada.token,
    });
    expect(edit.status).toBe(204);

    const ids = ((await groupExpenses(groupId, ada.token)).body as { id: string }[]).map(expense => expense.id);
    expect(ids).toEqual([newer, older]);
  });

  it('does not list a deleted expense', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const kept = idOf(
      await record(
        groupId,
        { description: 'Kept', amount: 100, date: '2025-05-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );
    const gone = idOf(
      await record(
        groupId,
        { description: 'Gone', amount: 100, date: '2025-05-02', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );

    expect((await http.request('DELETE', `${api}/expenses/${gone}`, { token: ada.token })).status).toBe(204);

    const ids = ((await groupExpenses(groupId, ada.token)).body as { id: string }[]).map(expense => expense.id);
    expect(ids).toEqual([kept]);
  });

  it('answers the group does not exist for anyone who is not a member', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const outsider = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace]);
    await record(
      groupId,
      { description: 'Rent', amount: 100, date: '2025-06-01', splitBetween: [ada.id, grace.id] },
      ada.token,
    );

    const answer = await groupExpenses(groupId, outsider.token);
    expect(answer.status).toBe(404);
    expect((await groupExpenses(groupId)).status).toBe(401);
  });
});

describe('a member’s statement', () => {
  it('lists the expenses the member paid or is in the split of, the earliest first, with the balance after each', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);

    // Recorded in this order. On 2025-07-01 two expenses Ada is in: the first recorded comes first in her statement.
    const first = idOf(
      await record(
        groupId,
        { description: 'First', amount: 200, date: '2025-07-01', splitBetween: [ada.id, grace.id] },
        grace.token,
      ),
    );
    const second = idOf(
      await record(
        groupId,
        { description: 'Second', amount: 300, date: '2025-07-01', splitBetween: [ada.id, grace.id, linus.id] },
        ada.token,
      ),
    );
    // Later in date, though recorded last of the three: it comes after both.
    const third = idOf(
      await record(
        groupId,
        { description: 'Third', amount: 900, date: '2025-07-10', splitBetween: [ada.id, grace.id, linus.id] },
        ada.token,
      ),
    );
    // Linus paid one that Ada is not in: not in her statement.
    await record(
      groupId,
      { description: 'Not hers', amount: 600, date: '2025-07-02', splitBetween: [grace.id, linus.id] },
      linus.token,
    );

    const answer = await statementOf(groupId, ada.id, grace.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      memberId: ada.id,
      balance: 700,
      entries: [
        {
          kind: 'expense',
          expenseId: first,
          date: '2025-07-01',
          description: 'First',
          paid: 0,
          share: 100,
          balance: -100,
        },
        {
          kind: 'expense',
          expenseId: second,
          date: '2025-07-01',
          description: 'Second',
          paid: 300,
          share: 100,
          balance: 100,
        },
        {
          kind: 'expense',
          expenseId: third,
          date: '2025-07-10',
          description: 'Third',
          paid: 900,
          share: 300,
          balance: 700,
        },
      ],
    });
  });

  it('is the group balance of the member: its last entry’s balance, or 0 when it has none', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);
    await record(
      groupId,
      { description: 'Lunch', amount: 1000, date: '2025-08-01', splitBetween: [grace.id, linus.id] },
      grace.token,
    );
    await record(
      groupId,
      {
        description: 'Taxi',
        amount: 333,
        date: '2025-08-02',
        splitExactly: [
          { memberId: ada.id, amount: 133 },
          { memberId: linus.id, amount: 200 },
        ],
      },
      linus.token,
    );

    const balances = (await balancesOf(groupId, ada.token)).body as { memberId: string; balance: number }[];
    for (const member of [ada, grace, linus]) {
      const statement = (await statementOf(groupId, member.id, ada.token)).body as {
        balance: number;
        entries: { balance: number }[];
      };
      expect(statement.balance).toBe(balances.find(line => line.memberId === member.id)!.balance);
      const last = statement.entries.at(-1)?.balance ?? 0;
      expect(statement.balance).toBe(last);
    }

    // Ada is in the taxi only, which she owes 133 of.
    const adaStatement = (await statementOf(groupId, ada.id, ada.token)).body as {
      balance: number;
      entries: unknown[];
    };
    expect(adaStatement.entries).toHaveLength(1);
    expect(adaStatement.balance).toBe(-133);
  });

  it('is 0 with no entries, for a member no expense counts', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);
    await record(
      groupId,
      { description: 'Rent', amount: 200, date: '2025-09-01', splitBetween: [ada.id, grace.id] },
      ada.token,
    );

    expect((await statementOf(groupId, linus.id, linus.token)).body).toEqual({
      memberId: linus.id,
      balance: 0,
      entries: [],
    });
  });

  it('does not count a deleted expense in the statement', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const gone = idOf(
      await record(
        groupId,
        { description: 'Gone', amount: 100, date: '2025-10-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );
    await http.request('DELETE', `${api}/expenses/${gone}`, { token: ada.token });

    expect((await statementOf(groupId, ada.id, ada.token)).body).toEqual({ memberId: ada.id, balance: 0, entries: [] });
  });

  it('answers the group does not exist for anyone who is not a member, and a non-member member does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const outsider = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace]);

    expect((await statementOf(groupId, ada.id, outsider.token)).status).toBe(404);
    expect((await statementOf(groupId, outsider.id, ada.token)).status).toBe(404);
    expect((await statementOf(groupId, ada.id)).status).toBe(401);
  });
});
