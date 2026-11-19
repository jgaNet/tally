import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Merging two groups, over HTTP (request 31): the owner of both merges the group merged into the group kept; its members join the group
 * kept, its expenses move to it, and the group merged is gone at once. The answers are held to the API `api/` gives, through `apiClient()`.
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

/** A group owned by `owner`, in `currency`, which each of `others` has joined through an invitation, in that order. */
async function groupWith(owner: { token: string }, others: { token: string }[], currency = 'EUR'): Promise<string> {
  const { id } = (await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency }, token: owner.token }))
    .body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const merge = (groupId: string, from: string, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/merge`, { body: { from }, token });
const readGroup = (groupId: string, token?: string) => http.request('GET', `${api}/groups/${groupId}`, { token });
const members = (groupId: string, token?: string) => http.request('GET', `${api}/groups/${groupId}/members`, { token });
const expensesOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/expenses`, { token });
const balancesOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });
const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });

/** The error's rule, as the answer names it. */
const refusedBy = (answer: { body: unknown }) => (answer.body as { type: string }).type;

/** Waits for what a reaction moves: the check is made again until it holds, for a few seconds at most (request 31: within seconds). */
async function eventually<T>(check: () => Promise<T>, holds: (value: T) => boolean): Promise<T> {
  let value = await check();
  for (let attempt = 0; attempt < 100 && !holds(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    value = await check();
  }
  return value;
}

describe('merging two groups', () => {
  it('the owner of both merges the group merged into the group kept, whose members and expenses it takes', async () => {
    const owner = await signedInPerson('Ann');
    const grace = await signedInPerson('Grace');
    const kept = await groupWith(owner, [grace]);
    const merged = await groupWith(owner, [grace]);
    const expense = (
      await record(
        merged,
        { description: 'Rent', amount: 90, date: '2020-02-01', splitBetween: [owner.id, grace.id] },
        owner.token,
      )
    ).body as {
      id: string;
    };

    expect((await merge(kept, merged, owner.token)).status).toBe(204);

    expect((await readGroup(merged, owner.token)).status).toBe(404);
    const listed = (await members(kept, owner.token)).body as { memberId: string; role: string }[];
    expect(listed.map(member => member.memberId)).toEqual([owner.id, grace.id]);
    const moved = await eventually(
      async () => (await expensesOf(kept, owner.token)).body as { id: string }[],
      list => list.some(item => item.id === expense.id),
    );
    expect(moved.map(item => item.id)).toContain(expense.id);
    const balances = await eventually(
      async () => (await balancesOf(kept, owner.token)).body as { memberId: string; balance: number }[],
      list => list.length === 2 && list.some(item => item.balance !== 0),
    );
    expect(balances.reduce((sum, item) => sum + item.balance, 0)).toBe(0);
    expect(balances.find(item => item.memberId === owner.id)?.balance).toBe(45);
  });

  it('refuses a merge that is not the owner of both, of one currency, of one group, or of an unknown group', async () => {
    const owner = await signedInPerson('Ben');
    const other = await signedInPerson('Cleo');
    const kept = await groupWith(owner, []);
    const theirs = await groupWith(other, []);
    const dollars = await groupWith(owner, [], 'USD');

    expect(refusedBy(await merge(kept, theirs, owner.token))).toBe('NotFound');
    expect(refusedBy(await merge(theirs, kept, owner.token))).toBe('NotFound');
    expect(refusedBy(await merge(kept, dollars, owner.token))).toBe('CurrenciesDiffer');
    expect(refusedBy(await merge(kept, kept, owner.token))).toBe('SameGroup');
    expect(refusedBy(await merge(kept, 'no-such-group', owner.token))).toBe('NotFound');
    expect((await readGroup(kept, owner.token)).status).toBe(200);
  });

  it('a group merged is gone: its invitations let no one join, and no expense is recorded in it', async () => {
    const owner = await signedInPerson('Dana');
    const late = await signedInPerson('Eli');
    const kept = await groupWith(owner, []);
    const merged = await groupWith(owner, []);
    const invitation = (await http.request('POST', `${api}/groups/${merged}/invitations`, { token: owner.token }))
      .body as {
      id: string;
    };

    expect((await merge(kept, merged, owner.token)).status).toBe(204);

    expect(
      refusedBy(await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: late.token })),
    ).toBe('NotFound');
    expect(
      refusedBy(
        await record(
          merged,
          { description: 'Late', amount: 10, date: '2020-02-02', splitBetween: [owner.id] },
          owner.token,
        ),
      ),
    ).toBe('NotFound');
  });

  it('refuses the merge into an archived group, as any change in one (request 27)', async () => {
    const owner = await signedInPerson('Fay');
    const kept = await groupWith(owner, []);
    const merged = await groupWith(owner, []);
    expect((await http.request('POST', `${api}/groups/${kept}/archive`, { token: owner.token })).status).toBe(204);

    expect(refusedBy(await merge(kept, merged, owner.token))).toBe('GroupArchived');
    expect((await readGroup(merged, owner.token)).status).toBe(200);
  });
});
