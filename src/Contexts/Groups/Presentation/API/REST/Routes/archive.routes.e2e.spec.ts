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
type Group = { id: string; name: string; currency: string; ownerId: string; archivedAt?: string };

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

/** Answers a command: a 202 is followed to its end, anything else is its status. */
async function answered(request: Promise<{ status: number; body: unknown }>, token: string): Promise<Operation> {
  const answer = await request;
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` };
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Signs someone up and in: their account's id, and the token that names it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function invitation(token: string, groupId: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** An expense of `amount` paid by the caller, split equally between the two members given. */
const recordBetween = (token: string, groupId: string, amount: number, members: string[]) =>
  answered(
    http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount, date: '2026-11-01', splitBetween: members },
    }),
    token,
  );

const archive = (token: string, groupId: string) =>
  answered(http.request('POST', `${api}/groups/${groupId}/archive`, { token }), token);

describe('Archiving a group (request 27)', () => {
  it('archives a group once every balance is 0, then refuses every change in it by GroupArchived and reads it as before', async () => {
    const ann = await signedIn('ann.archive@example.test', 'Ann');
    const bob = await signedIn('bob.archive@example.test', 'Bob');
    const group = await createGroup(ann.token, 'Trip');
    const open = await createGroup(ann.token, 'Still open');
    expect(
      (
        await answered(
          http.request('POST', `${api}/invitations/${await invitation(ann.token, group)}/accept`, { token: bob.token }),
          bob.token,
        )
      ).status,
    ).toBe('SUCCESS');

    // Ann paid 1000 for both of them, and Bob paid 1000 for both of them: every balance is 0 again.
    expect((await recordBetween(ann.token, group, 1000, [ann.id, bob.id])).status).toBe('SUCCESS');
    expect((await archive(ann.token, group)).error?.type).toBe('BalancesNotSettled');
    expect((await recordBetween(bob.token, group, 1000, [ann.id, bob.id])).status).toBe('SUCCESS');

    // Only the owner archives; a member's attempt is refused and changes nothing.
    expect((await archive(bob.token, group)).error?.type).toBe('OnlyTheOwnerMayArchive');
    expect((await archive(ann.token, group)).status).toBe('SUCCESS');

    // It reads when it was archived, and only the archived group does.
    const read = await http.get(`${api}/groups/${group}`, { token: ann.token });
    expect((read.body as Group).archivedAt).toEqual(expect.any(String));
    const notArchived = await http.get(`${api}/groups/${open}`, { token: ann.token });
    expect(notArchived.body).not.toHaveProperty('archivedAt');
    const mine = (await http.get(`${api}/groups/mine`, { token: ann.token })).body as Group[];
    expect(mine.find(item => item.id === group)?.archivedAt).toEqual(expect.any(String));

    // Every change is refused by the one name, and changes nothing.
    expect((await recordBetween(ann.token, group, 500, [ann.id, bob.id])).error?.type).toBe('GroupArchived');
    expect(
      (await answered(http.request('POST', `${api}/groups/${group}/invitations`, { token: ann.token }), ann.token))
        .error?.type,
    ).toBe('GroupArchived');
    expect(
      (await answered(http.request('POST', `${api}/groups/${group}/leave`, { token: bob.token }), bob.token)).error
        ?.type,
    ).toBe('GroupArchived');
    expect((await archive(ann.token, group)).error?.type).toBe('GroupArchived');

    // Its members read it as before: the balances are still there, 0 for each.
    const balances = await http.get(`${api}/groups/${group}/balances`, { token: bob.token });
    expect(balances.status).toBe(200);
    expect((balances.body as { balance: number }[]).every(row => row.balance === 0)).toBe(true);
  });
});
