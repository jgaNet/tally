import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Balances, over HTTP: every member's balance in the order they joined, the zero sum after expenses, the members only, and
 * a burst of expenses recorded at once counted once each. Groups and expenses are made through their own routes; the
 * answers are held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-balances-')), 'tally.sqlite');
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
const balancesOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

describe('a group’s balances', () => {
  it('lists every member in the order they joined, each at 0 before anything is recorded', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);

    const answer = await balancesOf(groupId, grace.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { memberId: ada.id, balance: 0 },
      { memberId: grace.id, balance: 0 },
      { memberId: linus.id, balance: 0 },
    ]);
  });

  it('is what each member paid less their shares, and adds up to 0 after expenses', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);

    // 900 split three ways: each owes 300; Ada paid it, so she is owed 600 and the others owe 300 each.
    await record(
      groupId,
      { description: 'Dinner', amount: 900, date: '2020-01-15', splitBetween: [ada.id, grace.id, linus.id] },
      ada.token,
    );
    // Grace paid 300 for Ada and herself: 150 each; she is owed 150 more, Ada owes 150.
    await record(
      groupId,
      { description: 'Taxi', amount: 300, date: '2020-01-16', splitBetween: [ada.id, grace.id] },
      grace.token,
    );

    const answer = await balancesOf(groupId, linus.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { memberId: ada.id, balance: 450 },
      { memberId: grace.id, balance: -150 },
      { memberId: linus.id, balance: -300 },
    ]);
    const total = (answer.body as { balance: number }[]).reduce((sum, { balance }) => sum + balance, 0);
    expect(total).toBe(0);
  });

  it('counts each of many expenses recorded at once exactly once, and still adds up to 0', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);

    // Ten expenses by Ada and ten by Grace, each 300 split three ways (100 each), all sent at the same moment.
    const everyone = [ada.id, grace.id, linus.id];
    const answers = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        record(
          groupId,
          { description: `Ada ${i}`, amount: 300, date: '2020-01-15', splitBetween: everyone },
          ada.token,
        ),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        record(
          groupId,
          { description: `Grace ${i}`, amount: 300, date: '2020-01-15', splitBetween: everyone },
          grace.token,
        ),
      ),
    ]);
    expect(answers.every(answer => answer.status === 201)).toBe(true);

    const answer = await balancesOf(groupId, ada.token);
    expect(answer.body).toEqual([
      { memberId: ada.id, balance: 1000 },
      { memberId: grace.id, balance: 1000 },
      { memberId: linus.id, balance: -2000 },
    ]);
  });

  it('is refused to anyone who is not a member, as a group that does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const outsider = await signedInPerson('Outsider');
    const groupId = await groupWith(ada, []);

    const answer = await balancesOf(groupId, outsider.token);
    expect(answer.status).toBe(404);
  });

  it('is refused without a signed-in caller, with 401', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    const answer = await balancesOf(groupId);
    expect(answer.status).toBe(401);
  });

  it('answers 404 for a group that is not there', async () => {
    const ada = await signedInPerson('Ada');

    const answer = await balancesOf('no-such-group', ada.token);
    expect(answer.status).toBe(404);
  });
});
