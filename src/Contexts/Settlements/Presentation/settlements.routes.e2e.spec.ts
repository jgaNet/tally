import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The suggested settlements, over HTTP (request 11): the transfers of the stated example, in the order made, the empty answer
 * when every balance is 0, a suggestion that changes nothing, and the members only. Groups, expenses and balances are made
 * through their own routes; the answers are held to the API `api/` gives, through `apiClient()`.
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

/** An expense recorded by `payer`, split by exact amounts, the payer among them (with 0 when they owe nothing of it). */
const recordExact = (groupId: string, payer: { token: string }, amount: number, splitExactly: unknown[]) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount, date: '2026-05-01', splitExactly },
    token: payer.token,
  });

const suggestedOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token });
const balancesOf = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

describe('the suggested settlements of a group', () => {
  it('are the transfers of the stated example, in the order made, from the members who owe to those who are owed', async () => {
    const ann = await signedInPerson('Ann');
    const bob = await signedInPerson('Bob');
    const cy = await signedInPerson('Cy');
    const dan = await signedInPerson('Dan');
    const groupId = await groupWith(ann, [bob, cy, dan]);

    // Ann is owed 500, Bob 100, Cy owes 300, Dan owes 300.
    await recordExact(groupId, ann, 300, [
      { memberId: ann.id, amount: 0 },
      { memberId: cy.id, amount: 300 },
    ]);
    await recordExact(groupId, ann, 200, [
      { memberId: ann.id, amount: 0 },
      { memberId: dan.id, amount: 200 },
    ]);
    await recordExact(groupId, bob, 100, [
      { memberId: bob.id, amount: 0 },
      { memberId: dan.id, amount: 100 },
    ]);
    const before = (await balancesOf(groupId, ann.token)).body;

    const answer = await suggestedOf(groupId, bob.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { from: cy.id, to: ann.id, amount: 300 },
      { from: dan.id, to: ann.id, amount: 200 },
      { from: dan.id, to: bob.id, amount: 100 },
    ]);
    // Reading the suggestion changes nothing: the balances are what the expenses make them.
    expect((await balancesOf(groupId, ann.token)).body).toEqual(before);
  });

  it('is empty when every balance is already 0, as a group with no expenses is', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const answer = await suggestedOf(groupId, grace.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([]);
  });

  it('is refused to anyone who is not a member, as a group that does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const outsider = await signedInPerson('Outsider');
    const groupId = await groupWith(ada, []);

    const answer = await suggestedOf(groupId, outsider.token);
    expect(answer.status).toBe(404);
  });

  it('is refused without a signed-in caller, with 401', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    const answer = await suggestedOf(groupId);
    expect(answer.status).toBe(401);
  });

  it('answers 404 for a group that is not there', async () => {
    const ada = await signedInPerson('Ada');

    const answer = await suggestedOf('no-such-group', ada.token);
    expect(answer.status).toBe(404);
  });
});
