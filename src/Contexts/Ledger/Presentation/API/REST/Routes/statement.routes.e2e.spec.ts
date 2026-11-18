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

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(email: string, name = 'Alice'): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** Creates a group and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Joins a group by an invitation, following the operation of the join. */
async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** Records an expense and follows its operation: SUCCESS with the id, or ERROR with the refusal. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Reads the statement of a member of a group, as the given reader reads it. */
async function statement(token: string, groupId: string, memberId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/groups/${groupId}/members/${memberId}/statement`, { token });
}

/** Records a settlement in cash, paid by `from` to the caller, and follows its operation. */
async function settle(token: string, groupId: string, body: { from: string; amount: number }): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

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

/** A day long past, which every expense may be spent on. */
const PAST_DAY = '2026-03-10';
const LATER_DAY = '2026-03-12';

describe("a group's expenses", () => {
  it('lists the expenses the latest date first, and on the same date the most recently recorded first; an edit keeps when it was recorded', async () => {
    const alice = await signedIn('hist-alice@example.com', 'Alice');
    const bob = await signedIn('hist-bob@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Listed');
    await join(alice.token, groupId, bob.token);

    const first = await record(alice.token, groupId, {
      description: 'First',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    const second = await record(alice.token, groupId, {
      description: 'Second',
      amount: 600,
      date: LATER_DAY,
      splitBetween: [alice.id, bob.id],
    });
    const third = await record(bob.token, groupId, {
      description: 'Third',
      amount: 300,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    expect([first.status, second.status, third.status]).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS']);

    const listed = await http.get(`${api}/groups/${groupId}/expenses`, { token: bob.token });
    expect(listed.status).toBe(200);
    const descriptions = (listed.body as { description: string }[]).map(expense => expense.description);
    expect(descriptions).toEqual(['Second', 'Third', 'First']);

    // An edit of the first one, the earliest recorded, to the same date: it keeps its place in the recording order.
    const edit = await http.request('PUT', `${api}/expenses/${first.result}`, {
      token: alice.token,
      body: {
        description: 'First, edited',
        amount: 1000,
        date: PAST_DAY,
        splitBetween: [alice.id, bob.id],
        version: 1,
      },
    });
    expect(await outcome((edit.body as { operationId: string }).operationId, alice.token)).toMatchObject({
      status: 'SUCCESS',
    });
    const afterEdit = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect((afterEdit.body as { description: string }[]).map(expense => expense.description)).toEqual([
      'Second',
      'Third',
      'First, edited',
    ]);
  });

  it('answers 404 for a group of a non-member, and 401 without a caller', async () => {
    const alice = await signedIn('hist-kay@example.com', 'Alice');
    const outsider = await signedIn('hist-lee@example.com', 'Lee');
    const groupId = await createGroup(alice.token, 'Private');

    expect((await http.get(`${api}/groups/${groupId}/expenses`, { token: outsider.token })).status).toBe(404);
    expect((await http.get(`${api}/groups/${groupId}/expenses`)).status).toBe(401);
  });
});

describe("a member's statement", () => {
  it('reads every expense the member paid or is in the split of, the earliest date first, with the running balance', async () => {
    const alice = await signedIn('stmt-alice@example.com', 'Alice');
    const bob = await signedIn('stmt-bob@example.com', 'Bob');
    const carl = await signedIn('stmt-carl@example.com', 'Carl');
    const groupId = await createGroup(alice.token, 'Statements');
    await join(alice.token, groupId, bob.token);
    await join(alice.token, groupId, carl.token);

    // Alice pays 1000 for herself and Bob (500 each), on the later day.
    await record(alice.token, groupId, {
      description: 'Dinner',
      amount: 1000,
      date: LATER_DAY,
      splitBetween: [alice.id, bob.id],
    });
    // Bob pays 300 for himself and Alice (150 each), on the earlier day, recorded after Dinner.
    await record(bob.token, groupId, {
      description: 'Fuel',
      amount: 300,
      date: PAST_DAY,
      splitBetween: [bob.id, alice.id],
    });
    // Alice pays 200 for herself and Bob, on the earlier day, recorded last: the same date as Fuel, so Fuel (recorded
    // before it) comes first.
    await record(alice.token, groupId, {
      description: 'Tea',
      amount: 200,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });

    const read = await statement(carl.token, groupId, alice.id);
    expect(read.status).toBe(200);
    // Alice: Fuel (share 150, balance -150), then Tea (paid 200, share 100, balance -50), then Dinner (paid 1000, share 500,
    // balance 450). Carl is in none of them, so his statement is empty.
    expect(read.body).toEqual({
      memberId: alice.id,
      balance: 450,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: PAST_DAY,
          description: 'Fuel',
          paid: 0,
          share: 150,
          balance: -150,
        },
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: PAST_DAY,
          description: 'Tea',
          paid: 200,
          share: 100,
          balance: -50,
        },
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: LATER_DAY,
          description: 'Dinner',
          paid: 1000,
          share: 500,
          balance: 450,
        },
      ],
    } satisfies Statement);

    // The statement's balance is the one the group's balances give the member.
    const groupBalances = (await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(groupBalances.find(member => member.memberId === alice.id)?.balance).toBe(450);

    const own = await statement(carl.token, groupId, carl.id);
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ memberId: carl.id, balance: 0, entries: [] } satisfies Statement);
  });

  it('answers 404 for a statement of someone who has never been a member, and for a non-member reader', async () => {
    const alice = await signedIn('stmt-kay@example.com', 'Alice');
    const bob = await signedIn('stmt-lee@example.com', 'Bob');
    const outsider = await signedIn('stmt-mia@example.com', 'Mia');
    const groupId = await createGroup(alice.token, 'Members only');
    await join(alice.token, groupId, bob.token);

    expect((await statement(alice.token, groupId, outsider.id)).status).toBe(404);
    expect((await statement(outsider.token, groupId, alice.id)).status).toBe(404);
  });
});

describe('Groups → Ledger', () => {
  it('lists the expenses and reads the statement of a group made in Groups by the id its operation answered, with a member who has just joined', async () => {
    const alice = await signedIn('stmt-uma@example.com', 'Alice');
    const bob = await signedIn('stmt-vic@example.com', 'Bob');
    // Groups makes the group and answers its id; Ledger finds the group by that same id, and a join is read at once.
    const groupId = await createGroup(alice.token, 'Read across');
    await join(alice.token, groupId, bob.token);

    expect(
      await record(bob.token, groupId, {
        description: 'Bread',
        amount: 100,
        date: PAST_DAY,
        splitBetween: [alice.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const listed = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject([{ groupId, description: 'Bread', paidBy: bob.id }]);

    expect((await statement(bob.token, groupId, bob.id)).body).toEqual({
      memberId: bob.id,
      balance: 50,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: PAST_DAY,
          description: 'Bread',
          paid: 100,
          share: 50,
          balance: 50,
        },
      ],
    } satisfies Statement);
  });

  it('lists the settlements the balances count beside the expenses, each on the day it started to count', async () => {
    const alice = await signedIn('st-settle-alice@example.com', 'Alice');
    const bob = await signedIn('st-settle-bob@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Settled');
    await join(alice.token, groupId, bob.token);
    await record(alice.token, groupId, {
      description: 'Dinner',
      amount: 300,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    // Bob pays Alice 100 in cash, which Alice records as its payee: counted from the moment it is recorded.
    expect(await settle(alice.token, groupId, { from: bob.id, amount: 100 })).toMatchObject({ status: 'SUCCESS' });

    const bobs = await statement(bob.token, groupId, bob.id);
    expect(bobs.body).toEqual({
      memberId: bob.id,
      balance: -50,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: PAST_DAY,
          description: 'Dinner',
          paid: 0,
          share: 150,
          balance: -150,
        },
        {
          kind: 'settlement',
          settlementId: expect.any(String),
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          description: 'Settlement in cash',
          paid: 100,
          share: 0,
          balance: -50,
        },
      ],
    } satisfies Statement);

    const alices = await statement(alice.token, groupId, alice.id);
    expect(alices.body).toEqual({
      memberId: alice.id,
      balance: 50,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: PAST_DAY,
          description: 'Dinner',
          paid: 300,
          share: 150,
          balance: 150,
        },
        {
          kind: 'settlement',
          settlementId: expect.any(String),
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          description: 'Settlement in cash',
          paid: 0,
          share: 100,
          balance: 50,
        },
      ],
    } satisfies Statement);
  });

  it('reads the statement as CSV: a header, one CRLF line per entry in the same order, and quotes only where a field needs them', async () => {
    const alice = await signedIn('st-csv-alice@example.com', 'Alice');
    const bob = await signedIn('st-csv-bob@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Exported');
    await join(alice.token, groupId, bob.token);
    await record(alice.token, groupId, {
      description: 'Pizza, "large"',
      amount: 300,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    expect(await settle(alice.token, groupId, { from: bob.id, amount: 100 })).toMatchObject({ status: 'SUCCESS' });

    const json = (await statement(bob.token, groupId, bob.id)).body as Statement;
    const [expense, settlement] = json.entries;
    const answer = await http.get(`${api}/groups/${groupId}/members/${bob.id}/statement.csv`, { token: bob.token });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(answer.body).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        `${PAST_DAY},expense,${expense.expenseId},"Pizza, ""large""",0,150,-150`,
        `${settlement.date},settlement,${settlement.settlementId},Settlement in cash,100,0,-50`,
        '',
      ].join('\r\n'),
    );
  });

  it('answers the CSV statement with the same refusals as the statement: 401 without a caller, 404 to a non-member', async () => {
    const ann = await signedIn('st-csv-refuse-ann@example.com', 'Ann');
    const stranger = await signedIn('st-csv-refuse-stranger@example.com', 'Stranger');
    const groupId = await createGroup(ann.token, 'Closed');

    expect(await http.get(`${api}/groups/${groupId}/members/${ann.id}/statement.csv`)).toMatchObject({ status: 401 });
    expect(
      await http.get(`${api}/groups/${groupId}/members/${ann.id}/statement.csv`, { token: stranger.token }),
    ).toMatchObject({ status: 404 });
  });
});
