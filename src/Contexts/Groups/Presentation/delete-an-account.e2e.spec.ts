import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 35 over HTTP: a person deletes their account. It is refused while they own a group with another member, and while a payment of theirs
 * through the provider waits; once deleted, nobody signs in with its email and password, its token proves nothing, and its email may be used again.
 * Its name is erased and shown as `Deleted account`, its id and its balances stay, and a deleted account is in no new split, paid through the
 * provider or netted with (`AccountDeleted`). The answers are held to the API `api/` gives, through `apiClient()`.
 */
const PASSWORD = 'a long password';

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

/** A signed-in person with the given email: its token and id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string; email: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } }))
    .body as { token: string };
  return { token, id: (created.body as { id: string }).id, email };
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

const deleteMe = (token?: string) => http.request('DELETE', `${api}/accounts/me`, { token });
const members = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/members`, { token })).body as {
    memberId: string;
    name: string;
    role: string;
  }[];
const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
    memberId: string;
    balance: number;
  }[];
const record = (groupId: string, body: Record<string, unknown>, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const netWith = (other: string, token: string) =>
  http.request('POST', `${api}/nettings`, { body: { with: other, currency: 'EUR' }, token });
const askProvider = (groupId: string, to: string, amount: number, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body: { to, amount }, token });

/** The error's rule, as the answer names it. */
const refusedBy = (answer: { body: unknown }) => (answer.body as { type: string }).type;

describe('deleting an account', () => {
  it('refuses while the caller owns a group with another member, and changes nothing', async () => {
    const owner = await signedIn('owner.delete@example.org', 'Owner');
    const other = await signedIn('other.delete@example.org', 'Other');
    await groupWith(owner, [other]);

    const refused = await deleteMe(owner.token);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(refusedBy(refused)).toBe('OwnsGroupWithMembers');
    // Still signed in, still named.
    expect(
      ((await http.request('GET', `${api}/accounts/me`, { token: owner.token })).body as { name: string }).name,
    ).toBe('Owner');
  });

  it('erases a member who deletes their account, keeps their balance and id, and refuses them everywhere after', async () => {
    const ann = await signedIn('ann.delete@example.org', 'Ann');
    const bob = await signedIn('bob.delete@example.org', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    // Ann pays 100, split between them: Bob owes Ann 50.
    const expense = (
      await record(
        groupId,
        { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [ann.id, bob.id] },
        ann.token,
      )
    ).body as { id: string };

    expect((await deleteMe(bob.token)).status).toBe(204);

    // Gone as a person: the token proves nothing, the sign-in is refused, the account is not read.
    expect((await http.request('GET', `${api}/accounts/me`, { token: bob.token })).status).toBe(401);
    const login = await http.request('POST', `${api}/accounts/login`, {
      body: { email: bob.email, password: PASSWORD },
    });
    expect(login.status).toBeGreaterThanOrEqual(400);
    expect(login.status).toBeLessThan(500);

    // Still a member, anonymous, with the balance it had; the balances still add up to 0.
    const listed = await members(groupId, ann.token);
    expect(listed.find(member => member.memberId === bob.id)).toMatchObject({
      name: 'Deleted account',
      role: 'member',
    });
    const balances = await balancesOf(groupId, ann.token);
    expect(balances.find(balance => balance.memberId === bob.id)?.balance).toBe(-50);
    expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);

    // The expense still names the deleted account's id.
    const read = (await http.request('GET', `${api}/expenses/${expense.id}`, { token: ann.token })).body as {
      shares: { memberId: string }[];
    };
    expect(read.shares.map(share => share.memberId)).toContain(bob.id);

    // Its email may be used by a new account, which is someone else.
    const again = await signedIn('bob.delete@example.org', 'Bobby');
    expect(again.id).not.toBe(bob.id);
  });

  it('refuses a deleted account in a new split, a provider payment and a netting, by the one name', async () => {
    const ann = await signedIn('ann.refuse@example.org', 'Ann');
    const cy = await signedIn('cy.refuse@example.org', 'Cy');
    const groupId = await groupWith(ann, [cy]);
    // Cy pays 100, split between them: Ann owes Cy 50, so a payment of Ann's to Cy is one Tally would take, were Cy not deleted.
    const paid = await record(
      groupId,
      { description: 'Lunch', amount: 100, date: '2020-01-10', splitBetween: [ann.id, cy.id] },
      cy.token,
    );
    expect(paid.status).toBeLessThan(300);
    expect((await deleteMe(cy.token)).status).toBe(204);

    expect(
      refusedBy(
        await record(
          groupId,
          { description: 'Taxi', amount: 10, date: '2020-01-16', splitBetween: [ann.id, cy.id] },
          ann.token,
        ),
      ),
    ).toBe('AccountDeleted');
    expect(refusedBy(await askProvider(groupId, cy.id, 10, ann.token))).toBe('AccountDeleted');
    expect(refusedBy(await netWith(cy.id, ann.token))).toBe('AccountDeleted');
  });
});
