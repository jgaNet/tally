import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Balances, end to end: the application booted in this process on a free port, spoken to over HTTP, every answer held
 * to api/5-balances.yaml by the client. One application per suite, shared by its tests in order.
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
    body: { name: 'The house', currency: 'EUR' },
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
const readBalances = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/balances`, { token });

/** Each share of an equal split: rounded down, the remainder whole to the payer (request 4). */
function sharesOf(amount: number, members: string[], payer: string): Record<string, number> {
  const each = Math.floor(amount / members.length);
  const shares: Record<string, number> = {};
  for (const member of members) shares[member] = member === payer ? amount - each * (members.length - 1) : each;
  return shares;
}

describe('a group’s balances', () => {
  it('answers every member in the order they joined, with what each is owed or owes, adding up to 0', async () => {
    const ana = await accountOf('ana.balances@example.com', 'Ana');
    const ben = await accountOf('ben.balances@example.com', 'Ben');
    const cy = await accountOf('cy.balances@example.com', 'Cy');
    const dan = await accountOf('dan.balances@example.com', 'Dan');
    const groupId = await groupWith(ana, [ben, cy, dan]);

    // Ana pays 1000 split between Ana and Ben: 500 each. Ana is owed 500, Ben owes 500.
    expect(
      (
        await record(groupId, ana.token, {
          description: 'Gas',
          amount: 1000,
          date: SPENT,
          splitBetween: [ana.id, ben.id],
        })
      ).status,
    ).toBe(201);
    // Ben pays 900 split between Ben, Ana and Cy: 300 each. Ben is owed 600 net; Ana and Cy each owe 300.
    expect(
      (
        await record(groupId, ben.token, {
          description: 'Dinner',
          amount: 900,
          date: SPENT,
          splitBetween: [ben.id, ana.id, cy.id],
        })
      ).status,
    ).toBe(201);

    const answer = await readBalances(groupId, dan.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { memberId: ana.id, balance: 200 },
      { memberId: ben.id, balance: 100 },
      { memberId: cy.id, balance: -300 },
      { memberId: dan.id, balance: 0 },
    ]);
    const total = (answer.body as { balance: number }[]).reduce((sum, { balance }) => sum + balance, 0);
    expect(total).toBe(0);
  });

  it('answers a group with nothing recorded as 0 for every member', async () => {
    const eve = await accountOf('eve.balances@example.com', 'Eve');
    const fay = await accountOf('fay.balances@example.com', 'Fay');
    const groupId = await groupWith(eve, [fay]);

    const answer = await readBalances(groupId, eve.token);
    expect(answer.body).toEqual([
      { memberId: eve.id, balance: 0 },
      { memberId: fay.id, balance: 0 },
    ]);
  });

  it('counts each expense once and keeps the sum at 0 when members record at the same moment', async () => {
    const gus = await accountOf('gus.balances@example.com', 'Gus');
    const hal = await accountOf('hal.balances@example.com', 'Hal');
    const ivy = await accountOf('ivy.balances@example.com', 'Ivy');
    const groupId = await groupWith(gus, [hal, ivy]);
    const members = [gus, hal, ivy];

    const expenses = Array.from({ length: 9 }, (_, i) => ({
      payer: members[i % 3],
      amount: 1001 + i * 37,
      description: `Expense ${i}`,
    }));
    const recorded = await Promise.all(
      expenses.map(({ payer, amount, description }) =>
        record(groupId, payer.token, {
          description,
          amount,
          date: SPENT,
          splitBetween: members.map(member => member.id),
        }),
      ),
    );
    expect(recorded.map(answer => answer.status)).toEqual(Array(9).fill(201));

    const expected = Object.fromEntries(members.map(member => [member.id, 0]));
    for (const { payer, amount } of expenses) {
      const shares = sharesOf(
        amount,
        members.map(member => member.id),
        payer.id,
      );
      expected[payer.id] += amount;
      for (const member of members) expected[member.id] -= shares[member.id];
    }

    const answer = await readBalances(groupId, ivy.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(members.map(member => ({ memberId: member.id, balance: expected[member.id] })));
    const total = (answer.body as { balance: number }[]).reduce((sum, { balance }) => sum + balance, 0);
    expect(total).toBe(0);
  });

  it('is read only by the members of the group: to anyone else it does not exist, and without a caller it is refused', async () => {
    const jo = await accountOf('jo.balances@example.com', 'Jo');
    const kim = await accountOf('kim.balances@example.com', 'Kim');
    const stranger = await accountOf('stranger.balances@example.com', 'Stranger');
    const groupId = await groupWith(jo, [kim]);

    const asStranger = await readBalances(groupId, stranger.token);
    expect(asStranger.status).toBe(404);
    expect(asStranger.body).toMatchObject({ type: 'NotFound' });

    const anonymous = await readBalances(groupId);
    expect(anonymous.status).toBe(401);
  });
});

describe('Groups → Ledger', () => {
  it('reads the balances of a group made through the API by the id that request answered, members as Groups has them', async () => {
    const lee = await accountOf('lee.balances@example.com', 'Lee');
    const max = await accountOf('max.balances@example.com', 'Max');

    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'The allotment', currency: 'GBP' },
      token: lee.token,
    });
    expect(created.status).toBe(201);
    const groupId = (created.body as { id: string }).id;

    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: lee.token });
    const joined = await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: max.token,
    });
    expect(joined.status).toBe(201);

    const answer = await readBalances(groupId, max.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { memberId: lee.id, balance: 0 },
      { memberId: max.id, balance: 0 },
    ]);
  });
});
