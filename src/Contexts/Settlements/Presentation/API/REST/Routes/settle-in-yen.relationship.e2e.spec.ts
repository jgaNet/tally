import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 40: Settlements reads the currency Groups made a group in (GroupCurrency), so a cash settlement in a group in yen is
 * decided in yen, in the yen's own minor unit: a whole number of yen, and never more than is owed in yen.
 */

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

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-yen-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group Groups makes in yen, by the id its request answered. */
async function createYenGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Tokyo', currency: 'JPY' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

describe('Groups → Settlements (GroupCurrency): a group Groups makes in yen is the one a cash settlement is decided in, in yen, by the id the group request answered', () => {
  it('decides a cash settlement of the yen a member owes in the group the request answered, and reads it back in that group', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const groupId = await createYenGroup(alice);
    await join(groupId, alice, bob);
    // Alice paid 1000 yen for the two of them: Bob owes 500 yen.
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Ramen', amount: 1000, date: '2025-06-01', splitBetween: [alice.id, bob.id] },
      token: alice.token,
    });
    expect((await outcome((expense.body as Body).operationId as string, alice.token)).body).toMatchObject({
      status: 'SUCCESS',
    });

    // Alice, the payee, records that Bob paid 500 yen in cash: 500 is a whole number of yen, and it is what is owed.
    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 500 },
      token: alice.token,
    });
    const settled = await outcome((answer.body as Body).operationId as string, alice.token);
    expect(settled.body).toMatchObject({ status: 'SUCCESS' });
    const settlementId = (settled.body as { result: { id: string } }).result.id;

    const kept = await http.get(`${api}/settlements/${settlementId}`, { token: alice.token });
    expect(kept.body).toMatchObject({
      id: settlementId,
      groupId,
      from: bob.id,
      to: alice.id,
      amount: 500,
      method: 'cash',
    });
    const listed = await http.get(`${api}/groups/${groupId}/settlements`, { token: alice.token });
    expect(listed.body as { id: string }[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: settlementId })]),
    );
  });
});
