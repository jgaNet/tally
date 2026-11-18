import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('history');

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';

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

const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const readExpenses = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/expenses`, { token });
const readStatement = (groupId: string, memberId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement`, { token });
const readBalances = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

type Entry = {
  kind: 'expense' | 'settlement';
  expenseId?: string;
  settlementId?: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
};
type Statement = { memberId: string; balance: number; entries: Entry[] };
type Balance = { memberId: string; balance: number };

describe("a group's expenses", () => {
  it('lists every expense, the latest date first, then the most recently recorded first, an edit not moving it', async () => {
    const ada = await signedIn('hist-ada@example.com', 'Ada');
    const ben = await signedIn('hist-ben@example.com', 'Ben');
    const cy = await signedIn('hist-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [ben, cy]);

    const first = (
      await record(ada.token, groupId, {
        description: 'Dinner',
        amount: 3000,
        date: '2026-01-15',
        splitBetween: [ada.id, ben.id, cy.id],
      })
    ).body as { id: string };
    const second = (
      await record(ben.token, groupId, {
        description: 'Taxi',
        amount: 900,
        date: '2026-01-10',
        splitBetween: [ada.id, ben.id],
      })
    ).body as { id: string };
    const third = (
      await record(cy.token, groupId, {
        description: 'Hotel',
        amount: 1200,
        date: '2026-01-15',
        splitBetween: [ada.id, cy.id],
      })
    ).body as { id: string };

    // Editing the first, recorded before the third, keeps its place: the edit is not a new recording.
    const read = (await readExpense(first.id, ada.token)).body as { version: number };
    const edit = await http.request('PUT', `${api}/expenses/${first.id}`, {
      body: {
        description: 'Dinner out',
        amount: 3000,
        date: '2026-01-15',
        version: read.version,
        splitBetween: [ada.id, ben.id, cy.id],
      },
      token: ada.token,
    });
    expect(edit.status).toBe(204);

    const listed = await readExpenses(groupId, ben.token);
    expect(listed.status).toBe(200);
    const expenses = listed.body as Array<{ id: string; description: string; version: number }>;
    expect(expenses.map(expense => expense.id)).toEqual([third.id, first.id, second.id]);
    expect(expenses.find(expense => expense.id === first.id)).toMatchObject({ description: 'Dinner out', version: 2 });
  });

  it('answers a deleted expense out of the list', async () => {
    const ada = await signedIn('hist-del-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);
    const kept = (
      await record(ada.token, groupId, { description: 'Kept', amount: 100, date: '2026-02-01', splitBetween: [ada.id] })
    ).body as { id: string };
    const gone = (
      await record(ada.token, groupId, { description: 'Gone', amount: 100, date: '2026-02-02', splitBetween: [ada.id] })
    ).body as { id: string };
    await http.request('DELETE', `${api}/expenses/${gone.id}`, { token: ada.token });

    const listed = (await readExpenses(groupId, ada.token)).body as Array<{ id: string }>;
    expect(listed.map(expense => expense.id)).toEqual([kept.id]);
  });

  it('answers the members only: anyone else does not see the group, and a missing caller is refused', async () => {
    const ada = await signedIn('hist-scope-ada@example.com', 'Ada');
    const eve = await signedIn('hist-scope-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, []);

    expect(await readExpenses(groupId, eve.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect((await readExpenses(groupId)).status).toBe(401);
  });
});

describe("a member's statement", () => {
  it('lists what the member paid or is in the split of, the earliest first, with the balance after each entry', async () => {
    const ada = await signedIn('stmt-ada@example.com', 'Ada');
    const ben = await signedIn('stmt-ben@example.com', 'Ben');
    const cy = await signedIn('stmt-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [ben, cy]);

    const dinner = (
      await record(ada.token, groupId, {
        description: 'Dinner',
        amount: 3000,
        date: '2026-01-15',
        splitBetween: [ada.id, ben.id, cy.id],
      })
    ).body as { id: string };
    const taxi = (
      await record(ben.token, groupId, {
        description: 'Taxi',
        amount: 900,
        date: '2026-01-10',
        splitBetween: [ada.id, ben.id],
      })
    ).body as { id: string };
    const hotel = (
      await record(cy.token, groupId, {
        description: 'Hotel',
        amount: 1200,
        date: '2026-01-15',
        splitBetween: [ada.id, cy.id],
      })
    ).body as { id: string };

    const adaStatement = await readStatement(groupId, ada.id, ben.token);
    expect(adaStatement.status).toBe(200);
    expect(adaStatement.body).toEqual<Statement>({
      memberId: ada.id,
      balance: 950,
      entries: [
        {
          kind: 'expense',
          expenseId: taxi.id,
          date: '2026-01-10',
          description: 'Taxi',
          paid: 0,
          share: 450,
          balance: -450,
        },
        {
          kind: 'expense',
          expenseId: dinner.id,
          date: '2026-01-15',
          description: 'Dinner',
          paid: 3000,
          share: 1000,
          balance: 1550,
        },
        {
          kind: 'expense',
          expenseId: hotel.id,
          date: '2026-01-15',
          description: 'Hotel',
          paid: 0,
          share: 600,
          balance: 950,
        },
      ],
    });

    // Ben is not in the hotel's split, and his statement has no line for it.
    const benStatement = (await readStatement(groupId, ben.id, cy.token)).body as Statement;
    expect(benStatement).toEqual<Statement>({
      memberId: ben.id,
      balance: -550,
      entries: [
        {
          kind: 'expense',
          expenseId: taxi.id,
          date: '2026-01-10',
          description: 'Taxi',
          paid: 900,
          share: 450,
          balance: 450,
        },
        {
          kind: 'expense',
          expenseId: dinner.id,
          date: '2026-01-15',
          description: 'Dinner',
          paid: 0,
          share: 1000,
          balance: -550,
        },
      ],
    });

    const cyStatement = (await readStatement(groupId, cy.id, ada.token)).body as Statement;
    expect(cyStatement).toEqual<Statement>({
      memberId: cy.id,
      balance: -400,
      entries: [
        {
          kind: 'expense',
          expenseId: dinner.id,
          date: '2026-01-15',
          description: 'Dinner',
          paid: 0,
          share: 1000,
          balance: -1000,
        },
        {
          kind: 'expense',
          expenseId: hotel.id,
          date: '2026-01-15',
          description: 'Hotel',
          paid: 1200,
          share: 600,
          balance: -400,
        },
      ],
    });

    // Each statement's balance is the group's balance of that member (request 5).
    const balances = (await readBalances(groupId, ada.token)).body as Balance[];
    const owed = Object.fromEntries(balances.map(({ memberId, balance }) => [memberId, balance]));
    expect(owed).toEqual({ [ada.id]: 950, [ben.id]: -550, [cy.id]: -400 });
    expect(adaStatement.body).toMatchObject({ balance: owed[ada.id] });
  });

  it('is 0 and has no entries for a member nothing is recorded for', async () => {
    const ada = await signedIn('stmt-empty-ada@example.com', 'Ada');
    const dan = await signedIn('stmt-empty-dan@example.com', 'Dan');
    const groupId = await groupWith(ada, [dan]);
    await record(ada.token, groupId, {
      description: 'Coffee',
      amount: 500,
      date: '2026-03-01',
      splitBetween: [ada.id],
    });

    expect((await readStatement(groupId, dan.id, dan.token)).body).toEqual<Statement>({
      memberId: dan.id,
      balance: 0,
      entries: [],
    });
  });

  it('answers the members only: anyone else does not see the group, and a stranger has no statement', async () => {
    const ada = await signedIn('stmt-scope-ada@example.com', 'Ada');
    const ben = await signedIn('stmt-scope-ben@example.com', 'Ben');
    const eve = await signedIn('stmt-scope-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, [ben]);

    expect(await readStatement(groupId, ada.id, eve.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    // Eve, who never joined, has no statement in the group, even read by a member.
    expect(await readStatement(groupId, eve.id, ben.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect((await readStatement(groupId, ada.id)).status).toBe(401);
  });
});

describe('Groups → Ledger', () => {
  it('reads the statement and the expenses of the group Groups made, by the id its creation answered, for a member who has just joined', async () => {
    const ada = await signedIn('gl-hist-ada@example.com', 'Ada');
    const bob = await signedIn('gl-hist-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    // Bob has just joined: Ledger asks Groups' membership at once (T3, ADR 4), so his statement and the list answer him now.
    const created = await record(bob.token, groupId, {
      description: 'Dinner',
      amount: 90,
      date: '2026-04-02',
      splitBetween: [bob.id, ada.id],
    });
    expect(created.status).toBe(201);
    const expenseId = (created.body as { id: string }).id;

    expect((await readStatement(groupId, bob.id, bob.token)).body).toEqual<Statement>({
      memberId: bob.id,
      balance: 45,
      entries: [
        { kind: 'expense', expenseId, date: '2026-04-02', description: 'Dinner', paid: 90, share: 45, balance: 45 },
      ],
    });
    expect(((await readExpenses(groupId, bob.token)).body as Array<{ id: string }>).map(expense => expense.id)).toEqual(
      [expenseId],
    );
  });
});
