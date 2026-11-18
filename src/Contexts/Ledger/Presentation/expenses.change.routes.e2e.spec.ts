import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Editing and deleting an expense, over HTTP (feature 6): who may change it, the version an edit is made from, two edits at
 * once, and the balances that follow. Groups are made and joined through the groups' own routes; the answers are held to
 * the API `api/` gives, through `apiClient()`.
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

/** A group owned by `owner`, which each of `others` has joined through an invitation. */
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
const getExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const editExpense = (id: string, body: Record<string, unknown>, token?: string) =>
  http.request('PUT', `${api}/expenses/${id}`, { body, token });
const deleteExpense = (id: string, token?: string) => http.request('DELETE', `${api}/expenses/${id}`, { token });
const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
    memberId: string;
    balance: number;
  }[];

/** A recorded expense of 1000 paid by `payer` and split equally between `members`, which the group's members are. */
async function recordedBy(
  groupId: string,
  payer: { token: string; id: string },
  members: { id: string }[],
): Promise<string> {
  const { id } = (
    await record(
      groupId,
      {
        description: 'Groceries',
        amount: 1000,
        date: '2020-01-15',
        splitBetween: [payer.id, ...members.map(member => member.id)],
      },
      payer.token,
    )
  ).body as { id: string };
  return id;
}

const edited = (overrides: Record<string, unknown> = {}) => ({
  description: 'Groceries, corrected',
  amount: 1200,
  date: '2020-01-16',
  splitBetween: [] as string[],
  version: 1,
  ...overrides,
});

describe('editing an expense', () => {
  it('lets its payer give it again, whole, from the version they read, and reads it back at the next version', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);
    const id = await recordedBy(groupId, ada, [grace]);

    const answer = await editExpense(id, edited({ splitBetween: [ada.id, grace.id, linus.id] }), ada.token);
    expect(answer.status).toBe(204);

    const read = await getExpense(id, grace.token);
    expect(read.body).toMatchObject({
      description: 'Groceries, corrected',
      amount: 1200,
      date: '2020-01-16',
      paidBy: ada.id,
      version: 2,
    });
    expect((read.body as { shares: { amount: number }[] }).shares.map(share => share.amount)).toEqual([400, 400, 400]);
  });

  it('lets the group owner edit an expense another member paid, and the payer stays the one who paid', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    const id = await recordedBy(groupId, grace, [owner]);

    const answer = await editExpense(id, edited({ splitBetween: [grace.id, owner.id] }), owner.token);
    expect(answer.status).toBe(204);
    expect((await getExpense(id, owner.token)).body).toMatchObject({ paidBy: grace.id, version: 2 });
  });

  it('refuses any other member by name, and to someone outside the group the expense does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const outsider = await signedInPerson('Outsider');
    const groupId = await groupWith(ada, [grace, linus]);
    const id = await recordedBy(groupId, grace, [ada, linus]);

    const byLinus = await editExpense(id, edited({ splitBetween: [grace.id] }), linus.token);
    expect(byLinus.status).toBe(403);
    expect(byLinus.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });

    const byOutsider = await editExpense(id, edited({ splitBetween: [grace.id] }), outsider.token);
    expect(byOutsider.status).toBe(404);
    expect((await getExpense(id, linus.token)).body).toMatchObject({ version: 1 });
  });

  it('refuses an edit made from a version the expense has left, by name, and keeps the expense as it is', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const id = await recordedBy(groupId, ada, []);
    expect((await editExpense(id, edited({ splitBetween: [ada.id] }), ada.token)).status).toBe(204);

    const stale = await editExpense(id, edited({ splitBetween: [ada.id], amount: 5, version: 1 }), ada.token);
    expect(stale.status).toBe(400);
    expect(stale.body).toEqual({ type: 'ExpenseChangedSinceRead', message: expect.any(String) });
    expect((await getExpense(id, ada.token)).body).toMatchObject({ amount: 1200, version: 2 });
  });

  it('refuses the second of two edits at once from one version, and keeps only the first, with the balances at 0', async () => {
    // Grace paid, and Ada owns the group: both may edit, and both read the expense at version 1.
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const id = await recordedBy(groupId, grace, [ada]);

    const [first, second] = await Promise.all([
      editExpense(id, edited({ splitBetween: [grace.id, ada.id], amount: 1400 }), grace.token),
      editExpense(id, edited({ splitBetween: [grace.id, ada.id], amount: 600 }), ada.token),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([204, 400]);
    const refused = first.status === 400 ? first : second;
    expect(refused.body).toEqual({ type: 'ExpenseChangedSinceRead', message: expect.any(String) });

    const kept = (await getExpense(id, ada.token)).body as { amount: number; version: number };
    expect(kept.version).toBe(2);
    expect([1400, 600]).toContain(kept.amount);
    const balances = await balancesOf(groupId, ada.token);
    expect(balances.reduce((sum, member) => sum + member.balance, 0)).toBe(0);
    expect(balances.find(member => member.memberId === grace.id)!.balance).toBe(kept.amount / 2);
  });

  it('refuses a body with no version, by its shape, at once', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const id = await recordedBy(groupId, ada, []);
    const withoutVersion: Record<string, unknown> = edited({ splitBetween: [ada.id] });
    delete withoutVersion.version;
    const answer = await editExpense(id, withoutVersion, ada.token);
    expect(answer.status).toBe(400);
  });

  it('answers 401 to an edit with no caller, and 404 for an expense that is not there', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const id = await recordedBy(groupId, ada, []);
    expect((await editExpense(id, edited({ splitBetween: [ada.id] }))).status).toBe(401);
    expect(
      (await editExpense('6f1d2c3b-0000-4000-8000-000000000999', edited({ splitBetween: [ada.id] }), ada.token)).status,
    ).toBe(404);
  });

  it('moves the balances with the edit: the payer is owed the new amount, each member owes their new share', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const id = await recordedBy(groupId, ada, [grace]);
    expect((await editExpense(id, edited({ splitBetween: [grace.id, ada.id], amount: 300 }), ada.token)).status).toBe(
      204,
    );

    expect(await balancesOf(groupId, ada.token)).toEqual([
      { memberId: ada.id, balance: 150 },
      { memberId: grace.id, balance: -150 },
    ]);
  });
});

describe('deleting an expense', () => {
  it('lets its payer delete it: it is no longer read, and it counts in no balance', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const id = await recordedBy(groupId, ada, [grace]);

    expect((await deleteExpense(id, ada.token)).status).toBe(204);
    expect((await getExpense(id, grace.token)).status).toBe(404);
    expect(await balancesOf(groupId, ada.token)).toEqual([
      { memberId: ada.id, balance: 0 },
      { memberId: grace.id, balance: 0 },
    ]);
  });

  it('lets the group owner delete an expense another member paid', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(owner, [grace]);
    const id = await recordedBy(groupId, grace, [owner]);
    expect((await deleteExpense(id, owner.token)).status).toBe(204);
    expect((await getExpense(id, grace.token)).status).toBe(404);
  });

  it('refuses any other member by name, and answers an outsider, or an expense already deleted, as not found', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const outsider = await signedInPerson('Outsider');
    const groupId = await groupWith(ada, [grace, linus]);
    const id = await recordedBy(groupId, grace, [ada, linus]);

    const byLinus = await deleteExpense(id, linus.token);
    expect(byLinus.status).toBe(403);
    expect(byLinus.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect((await deleteExpense(id, outsider.token)).status).toBe(404);

    expect((await deleteExpense(id, grace.token)).status).toBe(204);
    expect((await deleteExpense(id, grace.token)).status).toBe(404);
    expect((await editExpense(id, edited({ splitBetween: [grace.id] }), grace.token)).status).toBe(404);
  });

  it('answers 401 to a delete with no caller', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const id = await recordedBy(groupId, ada, []);
    expect((await deleteExpense(id)).status).toBe(401);
  });
});
