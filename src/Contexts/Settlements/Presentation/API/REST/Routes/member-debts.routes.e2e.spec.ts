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
  const email = `${name.toLowerCase()}-member-debts-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group as its owner, and answers the id the request answered (the operation's result). */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
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

/** Records an expense the caller paid, the operation followed to its outcome. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  await outcome((answer.body as Body).operationId as string, token);
}

describe('Groups → Settlements (SettlementMembers): the group Groups made is the one Settlements reads, by the id its request answered', () => {
  it('reads the suggested settlements of the group the create request answered, and finds no group for an id nobody made', async () => {
    const bob = await person('Bob');
    const groupId = await createGroup(bob);

    const found = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(found.status).toBe(200);
    expect(found.body).toEqual([]);

    const missing = await http.get(`${api}/groups/00000000-0000-0000-0000-000000000000/settlements/suggested`, {
      token: bob.token,
    });
    expect(missing.status).toBe(404);
  });
});

describe('Ledger → Settlements (GroupBalances): the expense Ledger records is the balance Settlements suggests from, by the id its request answered', () => {
  it('suggests the transfer the expense the record request answered makes, in the group the create request answered', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);
    await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 1000,
      date: '2025-06-01',
      splitBetween: [bob.id, cy.id],
    });

    const suggested = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: cy.token });
    expect(suggested.status).toBe(200);
    expect(suggested.body).toEqual([{ from: cy.id, to: bob.id, amount: 500 }]);
  });
});
