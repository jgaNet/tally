import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Suggested settlements, end to end: the application booted in this process on a free port, spoken to over HTTP, every
 * answer held to api/11-suggested-settlements.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by `owner`, which each of `others` joins by an invitation, in the order given: the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The cabin', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const readSuggestion = (groupId: string, token?: string) =>
  http.get(`/v1/groups/${groupId}/settlements/suggested`, { token });

describe('a group’s suggested settlements', () => {
  it('answers the transfers of the stated example, in the order they are made, from the members’ balances', async () => {
    const ann = await accountOf('ann.settlements@example.com', 'Ann');
    const bob = await accountOf('bob.settlements@example.com', 'Bob');
    const cy = await accountOf('cy.settlements@example.com', 'Cy');
    const dan = await accountOf('dan.settlements@example.com', 'Dan');
    const groupId = await groupWith(ann, [bob, cy, dan]);

    // Balances: Ann 500, Bob 100, Cy -300, Dan -300 (each expense split equally, the amounts divisible by the split).
    const expenses: [{ token: string }, number, string[]][] = [
      [ann, 600, [ann.id, cy.id, dan.id]],
      [ann, 200, [ann.id, dan.id]],
      [bob, 200, [bob.id, cy.id]],
    ];
    for (const [payer, amount, splitBetween] of expenses) {
      expect(
        (await record(groupId, payer.token, { description: 'Shared', amount, date: SPENT, splitBetween })).status,
      ).toBe(201);
    }

    const answer = await readSuggestion(groupId, dan.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { from: cy.id, to: ann.id, amount: 300 },
      { from: dan.id, to: ann.id, amount: 200 },
      { from: dan.id, to: bob.id, amount: 100 },
    ]);
  });

  it('answers no transfer for a group whose balances are all 0, and records nothing', async () => {
    const eve = await accountOf('eve.settlements@example.com', 'Eve');
    const fay = await accountOf('fay.settlements@example.com', 'Fay');
    const groupId = await groupWith(eve, [fay]);

    const first = await readSuggestion(groupId, eve.token);
    expect(first.status).toBe(200);
    expect(first.body).toEqual([]);

    // Reading changes nothing: the balances are still what the expenses make them, and the answer is the same again.
    const again = await readSuggestion(groupId, fay.token);
    expect(again.body).toEqual([]);
  });

  it('is read only by the members of the group: to anyone else it does not exist, and without a caller it is refused', async () => {
    const gus = await accountOf('gus.settlements@example.com', 'Gus');
    const hal = await accountOf('hal.settlements@example.com', 'Hal');
    const stranger = await accountOf('stranger.settlements@example.com', 'Stranger');
    const groupId = await groupWith(gus, [hal]);

    const asStranger = await readSuggestion(groupId, stranger.token);
    expect(asStranger.status).toBe(404);
    expect(asStranger.body).toMatchObject({ type: 'NotFound' });

    const anonymous = await readSuggestion(groupId);
    expect(anonymous.status).toBe(401);
  });
});

describe('Groups → Settlements', () => {
  it('lists in no suggestion a member who has left the group, once they owe nothing, and only the members still in it', async () => {
    const dan = await accountOf('dan.groups.settlements@example.com', 'Dan');
    const eli = await accountOf('eli.groups.settlements@example.com', 'Eli');
    const fred = await accountOf('fred.groups.settlements@example.com', 'Fred');
    const groupId = await groupWith(dan, [eli, fred]);
    const bus = await record(groupId, dan.token, {
      description: 'Bus',
      amount: 600,
      date: SPENT,
      splitBetween: [dan.id, eli.id, fred.id],
    });
    expect(bus.status).toBe(201);

    // Eli pays Dan the 200 in cash, so Eli owes nothing and may leave; Fred still owes Dan 200.
    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: eli.id, amount: 200 },
      token: dan.token,
    });
    expect(paid.status).toBe(201);
    const left = await http.request('POST', `/v1/groups/${groupId}/leave`, { token: eli.token });
    expect(left.status).toBe(201);

    const answer = await readSuggestion(groupId, fred.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([{ from: fred.id, to: dan.id, amount: 200 }]);
  });

  it('finds a group made in Groups by the id its creation answered, and orders the members as Groups has them', async () => {
    const ann = await accountOf('ann.groups.settlements@example.com', 'Ann');
    const bob = await accountOf('bob.groups.settlements@example.com', 'Bob');
    const cy = await accountOf('cy.groups.settlements@example.com', 'Cy');

    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'The loft', currency: 'EUR' },
      token: ann.token,
    });
    expect(created.status).toBe(201);
    const groupId = (created.body as { id: string }).id;

    // Bob, then Cy, join: Groups' join order is the order Settlements reads, and so the order a tie is paid in.
    for (const other of [bob, cy]) {
      const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: ann.token });
      const joined = await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: other.token,
      });
      expect(joined.status).toBe(201);
    }

    // Ann pays 300 split between the three: Ann is owed 200; Bob and Cy each owe 100.
    const recorded = await record(groupId, ann.token, {
      description: 'Hut',
      amount: 300,
      date: SPENT,
      splitBetween: [ann.id, bob.id, cy.id],
    });
    expect(recorded.status).toBe(201);

    const answer = await readSuggestion(groupId, cy.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { from: bob.id, to: ann.id, amount: 100 },
      { from: cy.id, to: ann.id, amount: 100 },
    ]);
  });
});

describe('Ledger → Settlements', () => {
  it('counts a settlement paid in cash in the balance it suggests from: what is paid is no longer owed', async () => {
    const ann = await accountOf('ann.ledger.paid.settlements@example.com', 'Ann');
    const bob = await accountOf('bob.ledger.paid.settlements@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    const taxi = await record(groupId, ann.token, {
      description: 'Taxi',
      amount: 1000,
      date: SPENT,
      splitBetween: [ann.id, bob.id],
    });
    expect(taxi.status).toBe(201);

    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 500 },
      token: ann.token,
    });
    expect(paid.status).toBe(201);

    const answer = await readSuggestion(groupId, bob.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([]);
  });

  it('counts an expense made through the API, and the expense read by the id that request answered is the one the suggestion counts', async () => {
    const ann = await accountOf('ann.ledger.settlements@example.com', 'Ann');
    const bob = await accountOf('bob.ledger.settlements@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);

    const recorded = await record(groupId, ann.token, {
      description: 'Taxi',
      amount: 1000,
      date: SPENT,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    // The expense that answered that id: Ann paid 1000, and each of the two owes 500.
    const expense = await http.get(`/v1/expenses/${expenseId}`, { token: ann.token });
    expect(expense.status).toBe(200);
    expect(expense.body).toMatchObject({ id: expenseId, groupId, amount: 1000, paidBy: ann.id });

    // The suggestion counts that expense: Bob owes Ann 500, which is the whole of what Ann is owed.
    const answer = await readSuggestion(groupId, bob.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([{ from: bob.id, to: ann.id, amount: 500 }]);
  });
});
