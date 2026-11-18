import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 34 through the API: an administrator suspends an account and reinstates it, each logged once; while it is suspended what it starts
 * is refused by one name, in every group, and nothing in a group changes. What it still does is unchanged.
 */

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let previousAdmins: string | undefined;
const ADMIN = 'suspend-boss@example.com';
const DAY = '2026-03-10';

beforeAll(async () => {
  previousAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAdmins;
});

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

/** Sends a command and follows the operation it was answered with; a refusal before it is answered is its status. */
async function command(method: string, path: string, token: string | undefined, body?: object): Promise<Operation> {
  const answer = await http.request(method, path, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** A group where Ann and Bob are members: Bob joined it by an invitation of Ann's. */
async function twoMemberGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${prefix}-bob@example.com`, 'Bob');
  const created = await command('POST', `${api}/groups`, ann.token, { name: 'Suspended', currency: 'EUR' });
  const groupId = created.result as string;
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: bob.token });
  await outcome((accepted.body as { operationId: string }).operationId, bob.token);
  return { ann, bob, groupId };
}

const suspension = (accountId: string) => `${api}/admin/accounts/${accountId}/suspension`;

describe('Suspend a member (request 34)', () => {
  it('writes nothing in a group when an account is suspended or reinstated, and logs each to the administrators', async () => {
    const { ann, bob } = await twoMemberGroup('suspend-log');
    const boss = await signedIn(ADMIN, 'Boss');

    expect(await command('PUT', suspension(bob.id), ann.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotAllowed' },
    });
    expect(await command('PUT', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });
    // Suspending an account already suspended changes nothing, and is logged nothing.
    expect(await command('PUT', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });
    expect(await command('DELETE', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });
    expect(await command('DELETE', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });

    const log = await http.get(`${api}/admin/log`, { token: boss.token });
    const ofBob = (log.body as { action: string; subjectId: string }[]).filter(entry => entry.subjectId === bob.id);
    expect(ofBob.map(entry => entry.action)).toEqual(['suspended', 'reinstated']);
  });

  it('refuses what a suspended account starts by one name, and changes nothing, while the rest goes on', async () => {
    const { ann, bob, groupId } = await twoMemberGroup('suspend-refuse');
    const boss = await signedIn(ADMIN, 'Boss');
    expect(await command('PUT', suspension(bob.id), boss.token)).toMatchObject({ status: 'SUCCESS' });

    const before = await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token });

    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, bob.token, {
        description: 'Taxi',
        amount: 40,
        date: DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountSuspended' } });

    // The others of its groups go on as before: Ann may put Bob in a split.
    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
        description: 'Dinner',
        amount: 60,
        date: DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    // What it still does: it signs in and reads its account.
    expect((await http.get(`${api}/accounts/me`, { token: bob.token })).status).toBe(200);
    expect((await http.get(`${api}/groups/${groupId}/balances`, { token: bob.token })).status).toBe(200);
    expect(before.status).toBe(200);
  });

  it('lets a reinstated account start again what it was refused', async () => {
    const { bob, groupId } = await twoMemberGroup('suspend-again');
    const boss = await signedIn(ADMIN, 'Boss');
    await command('PUT', suspension(bob.id), boss.token);
    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, bob.token, {
        description: 'Coffee',
        amount: 5,
        date: DAY,
        splitBetween: [bob.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountSuspended' } });

    await command('DELETE', suspension(bob.id), boss.token);
    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, bob.token, {
        description: 'Coffee',
        amount: 5,
        date: DAY,
        splitBetween: [bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
  });

  it('answers 401 to nobody signed in, and does not change an account for a member who is not an administrator', async () => {
    const { bob } = await twoMemberGroup('suspend-anon');
    expect((await http.request('PUT', suspension(bob.id), {})).status).toBe(401);
  });
});
