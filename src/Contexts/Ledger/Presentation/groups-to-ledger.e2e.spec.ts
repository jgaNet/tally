import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups → Ledger (ADR 5): Ledger asks Groups who the members of a group are, through its `IGroupMembers` port, over
 * Groups' read model. Over HTTP: a group made in Groups keeps the id its request answered, and Ledger finds it by that id
 * when an expense is recorded in it, and a member who has just joined can be in a split at once.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-groups-to-ledger-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
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

describe('Groups → Ledger', () => {
  it('finds, by the id Groups answered, the group an expense is recorded in, and a member who has just joined can be in its split', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    expect(created.status).toBe(201);
    const { id: groupId } = created.body as { id: string };

    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });

    // Linus joins, and the expense that same moment names him: Ledger reads the members as Groups has them now.
    const second = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${second.id}/accept`, { token: linus.token });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Groceries',
        amount: 300,
        date: '2020-01-15',
        splitBetween: [linus.id, ada.id, grace.id],
      },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const { id: expenseId } = recorded.body as { id: string };

    const read = await http.request('GET', `${api}/expenses/${expenseId}`, { token: grace.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      groupId,
      paidBy: ada.id,
      shares: [
        { memberId: linus.id, amount: 100 },
        { memberId: ada.id, amount: 100 },
        { memberId: grace.id, amount: 100 },
      ],
    });
  });

  it('reads, by the id Groups answered, the balances of its members in the order they joined, the one who joined later included', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }

    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Groceries', amount: 300, date: '2020-01-15', splitBetween: [ada.id, grace.id, linus.id] },
      token: ada.token,
    });

    const answer = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: linus.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { memberId: ada.id, balance: 200 },
      { memberId: grace.id, balance: -100 },
      { memberId: linus.id, balance: -100 },
    ]);
  });

  it('reads, from Groups, the role of each member, so the owner of a group made in Groups may change an expense another member recorded in it', async () => {
    const owner = await signedInPerson('Owner');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
    ).body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }

    const { id: expenseId } = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Bread', amount: 300, date: '2020-01-15', splitBetween: [grace.id, linus.id] },
        token: grace.token,
      })
    ).body as { id: string };

    // Linus is a member, but neither the payer nor the owner: refused. The owner, who is not the payer, may edit it.
    const edit = {
      description: 'Bread',
      amount: 200,
      date: '2020-01-15',
      splitBetween: [grace.id, linus.id],
      version: 1,
    };
    expect((await http.request('PUT', `${api}/expenses/${expenseId}`, { body: edit, token: linus.token })).status).toBe(
      403,
    );
    expect((await http.request('PUT', `${api}/expenses/${expenseId}`, { body: edit, token: owner.token })).status).toBe(
      204,
    );
    expect((await http.request('GET', `${api}/expenses/${expenseId}`, { token: owner.token })).body).toMatchObject({
      paidBy: grace.id,
      version: 2,
    });
  });

  it('does not find a group Groups does not have a member in: Ledger answers it as a group that does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const stranger = await signedInPerson('Stranger');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Bread', amount: 5, date: '2020-01-15', splitBetween: [stranger.id] },
      token: stranger.token,
    });
    expect(answer.status).toBe(404);
  });

  it('reads, by the id Groups answered, the group’s expenses and a member’s statement, and a member who never joined has none', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const stranger = await signedInPerson('Stranger');

    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });

    const { id: expenseId } = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Bread', amount: 300, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
        token: ada.token,
      })
    ).body as { id: string };

    const listed = await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: grace.token });
    expect(listed.status).toBe(200);
    expect((listed.body as { id: string }[]).map(expense => expense.id)).toEqual([expenseId]);

    const statement = await http.request('GET', `${api}/groups/${groupId}/members/${grace.id}/statement`, {
      token: grace.token,
    });
    expect(statement.status).toBe(200);
    expect(statement.body).toEqual({
      memberId: grace.id,
      balance: -150,
      entries: [{ expenseId, date: '2020-01-15', description: 'Bread', paid: 0, share: 150, balance: -150 }],
    });

    expect(
      (await http.request('GET', `${api}/groups/${groupId}/members/${stranger.id}/statement`, { token: ada.token }))
        .status,
    ).toBe(404);
  });
});
