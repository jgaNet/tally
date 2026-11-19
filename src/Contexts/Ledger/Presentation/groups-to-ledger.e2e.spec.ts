import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups → Ledger (ADR 5): Ledger asks Groups who the members of a group are, through its `IGroupMembers` port, over
 * Groups' read model. Over HTTP: a group made in Groups keeps the id its request answered, and Ledger finds it by that id
 * when an expense is recorded in it, and a member who has just joined can be in a split at once.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/**
 * A fake rates service (request 22): it offers one rate, from EUR to GBP, and none for any other pair, so a rate is answered only when
 * Ledger asks for the pair of the group's currency as Groups has it.
 */
let rates: Server;
let ratesOrigin: string;
/** A fake receipts store (request 26): it keeps any file and answers `201 { id, url }`, so an attached receipt is kept. */
let receipts: Server;
let receiptsOrigin: string;

beforeAll(async () => {
  rates = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url?.startsWith('/rates/EUR/GBP?')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rate: '1.1' }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', () => resolve()));
  ratesOrigin = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;
  receipts = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'file-1', url: `${receiptsOrigin}/files/file-1` }));
    });
  });
  await new Promise<void>(resolve => receipts.listen(0, '127.0.0.1', () => resolve()));
  receiptsOrigin = `http://127.0.0.1:${(receipts.address() as AddressInfo).port}`;
  process.env.RECEIPTS_URL = receiptsOrigin;
  // `RATES_URL` is unset for the other tests of this file: a server without a rates service takes the payer's rate (request 21).
  process.env.DATABASE_URL = await freshDatabaseUrl();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  receipts.closeAllConnections();
  await new Promise(resolve => receipts.close(resolve));
  await new Promise(resolve => rates.close(resolve));
});

/** Today, as the server says it: the `Date` header every answer carries, so that a test reads no clock of its own (ARCH-E2E). */
const todayOfServer = async (): Promise<Date> =>
  new Date(String((await http.request('GET', `${api}/accounts/me`)).headers.get('date')));

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
  it('refuses an expense in a group Groups archived, found by the id it answered, by GroupArchived, and keeps no expense of it', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    expect((await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ada.token })).status).toBe(204);

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Late', amount: 10, date: '2020-01-16', splitBetween: [ada.id, grace.id] },
      token: grace.token,
    });
    expect(refused.body).toMatchObject({ type: 'GroupArchived' });
    expect((await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ada.token })).body).toEqual([]);
  });

  it('reads, by the id Groups answered, the currency of the group made in Groups: the rate offered is to that currency, and no other', async () => {
    const ada = await signedInPerson('Ada');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Londres', currency: 'GBP' },
      token: ada.token,
    });
    expect(created.status).toBe(201);
    const { id: groupId } = created.body as { id: string };

    process.env.RATES_URL = ratesOrigin;
    try {
      // The rate from EUR is offered to GBP, the group's currency, and only the service's pair answers.
      const offered = await http.request('GET', `${api}/groups/${groupId}/rates/EUR?date=2026-11-16`, {
        token: ada.token,
      });
      expect(offered.status).toBe(200);
      expect(offered.body).toEqual({ currency: 'EUR', date: '2026-11-16', rate: '1.1' });
      const sameAsGroup = await http.request('GET', `${api}/groups/${groupId}/rates/GBP?date=2026-11-16`, {
        token: ada.token,
      });
      expect(sameAsGroup.status).toBe(404);
    } finally {
      delete process.env.RATES_URL;
    }
  });

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
      entries: [
        { kind: 'expense', expenseId, date: '2020-01-15', description: 'Bread', paid: 0, share: 150, balance: -150 },
      ],
    });

    expect(
      (await http.request('GET', `${api}/groups/${groupId}/members/${stranger.id}/statement`, { token: ada.token }))
        .status,
    ).toBe(404);
  });
  it('does not count a member who left Groups: the group they left is not found by them, and Ledger refuses them in a split', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token })).status).toBe(204);

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ada.token })).body as {
      memberId: string;
    }[];
    expect(balances.map(balance => balance.memberId)).toEqual([ada.id]);
    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Bread', amount: 300, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    expect(refused.status).toBe(400);
  });
  it('sets up, by the id Groups answered, a recurring expense in a group made in Groups, and only a member Groups has can be in its split', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const stranger = await signedInPerson('Stranger');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    const now = await todayOfServer();
    const startsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5)).toISOString().slice(0, 10);
    const body = { description: 'Rent', amount: 1000, startsOn, splitBetween: [ada.id, grace.id] };

    const refused = await http.request('POST', `${api}/groups/${groupId}/recurring`, { body, token: stranger.token });
    expect(refused.status).toBe(404);
    const set = await http.request('POST', `${api}/groups/${groupId}/recurring`, { body, token: ada.token });
    expect(set.status).toBe(201);
    const { id } = set.body as { id: string };

    const listed = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: grace.token });
    expect((listed.body as { id: string; groupId: string }[]).map(recurring => recurring.id)).toEqual([id]);
    expect((listed.body as { groupId: string }[])[0].groupId).toBe(groupId);
  });

  it('reads, from Groups, the currency of the group made in Groups: an expense paid in that currency is refused, and one paid in another is counted in it', async () => {
    const ada = await signedInPerson('Ada');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };

    const sameCurrency = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Tram',
        original: { currency: 'EUR', amount: 300, rate: '1' },
        date: '2020-01-15',
        splitBetween: [ada.id],
      },
      token: ada.token,
    });
    expect(sameCurrency.status).toBe(400);
    expect(sameCurrency.body).toEqual({ type: 'OriginalCurrencyIsGroupCurrency', message: expect.any(String) });

    const otherCurrency = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Tram',
        original: { currency: 'USD', amount: 1000, rate: '0.9' },
        date: '2020-01-15',
        splitBetween: [ada.id],
      },
      token: ada.token,
    });
    expect(otherCurrency.status).toBe(201);
    const { id: expenseId } = otherCurrency.body as { id: string };
    expect((await http.request('GET', `${api}/expenses/${expenseId}`, { token: ada.token })).body).toMatchObject({
      groupId,
      amount: 900,
      original: { currency: 'USD', amount: 1000, rate: '0.9' },
    });
  });
  it('reads, from Groups, who the owner of the group made in Groups is: only they set its budgets, and every member reads them by the id Groups answered', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });

    const byMember = await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      body: { amount: 40000 },
      token: grace.token,
    });
    expect(byMember.status).toBe(403);
    const byOwner = await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      body: { amount: 40000 },
      token: ada.token,
    });
    expect(byOwner.status).toBe(204);
    const read = await http.request('GET', `${api}/groups/${groupId}/budgets`, { token: grace.token });
    expect(read.body).toEqual([{ category: 'groceries', amount: 40000, spent: 0 }]);
  });
  it('splits an expense by a template saved over the members Groups gives: the ids its requests answered, and a member who left is refused', async () => {
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

    const saved = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      body: { name: 'Flat', splitBetween: [ada.id, grace.id, linus.id] },
      token: grace.token,
    });
    expect(saved.status).toBe(201);
    const templateId = (saved.body as { id: string }).id;

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Rent', amount: 900, date: '2026-01-15', template: templateId },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const expense = (
      await http.request('GET', `${api}/expenses/${(recorded.body as { id: string }).id}`, { token: ada.token })
    ).body as { shares: { memberId: string }[] };
    expect(expense.shares.map(share => share.memberId).sort()).toEqual([ada.id, grace.id, linus.id].sort());

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: linus.token })).status).toBe(204);
    const afterLeaving = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Rent', amount: 900, date: '2026-01-15', template: templateId },
      token: ada.token,
    });
    expect(afterLeaving.status).toBe(400);
    expect((afterLeaving.body as { type: string }).type).toBe('SplitMemberNotInGroup');
  });

  it('reads, from Groups, who may attach a receipt to an expense in a group made in Groups: its payer and its owner, and no other member', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const hugo = await signedInPerson('Hugo');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    for (const person of [grace, hugo]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }
    // Grace paid the expense: she may attach a receipt to it; Ada, the owner Groups made, may too; Hugo, neither, is refused.
    const { id: expenseId } = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Groceries', date: '2026-11-10', amount: 8700, splitBetween: [ada.id, grace.id, hugo.id] },
        token: grace.token,
      })
    ).body as { id: string };
    const attach = (token: string) =>
      http.request('PUT', `${api}/expenses/${expenseId}/receipt`, {
        body: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        headers: { 'content-type': 'application/octet-stream' },
        token,
      });

    expect((await attach(hugo.token)).status).toBe(403);
    expect((await attach(ada.token)).status).toBe(204);
    expect((await attach(grace.token)).status).toBe(204);
    expect((await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: hugo.token })).body).toEqual({
      type: 'image/jpeg',
      size: 6,
      url: `${receiptsOrigin}/files/file-1`,
    });
  });
});

/** Request 34 across the link: an administrator suspends an account whose id Groups answered at sign-up, and Ledger refuses that account's expense by name. */
describe('Groups → Ledger, a suspended account (request 34)', () => {
  it('refuses an expense the suspended account records in a group Ledger reads, and lets the other members go on', async () => {
    process.env.ADMIN_EMAILS = 'root@example.org';
    await http.request('POST', `${api}/accounts`, {
      body: { email: 'root@example.org', password: 'a long password', name: 'Root' },
    });
    const admin = (
      await http.request('POST', `${api}/accounts/login`, {
        body: { email: 'root@example.org', password: 'a long password' },
      })
    ).body as { token: string };
    const ann = await signedInPerson('Ann');
    const bob = await signedInPerson('Bob');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ann.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: bob.token });

    expect(
      (await http.request('PUT', `${api}/admin/accounts/${ann.id}/suspension`, { token: admin.token })).status,
    ).toBe(204);

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Taxi', amount: 10, date: '2020-01-16', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { type: string }).type).toBe('AccountSuspended');
    const bobs = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Bus', amount: 20, date: '2020-01-17', splitBetween: [ann.id, bob.id] },
      token: bob.token,
    });
    expect(bobs.status).toBe(201);
  });
});

/** A person signed in with an email of this test's, as request 35 names them: the token, and the id their sign-up answered. */
async function deletionPerson(name: string): Promise<{ token: string; id: string }> {
  const email = `${name.toLowerCase()}.deleted35@example.org`;
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: 'a long password', name } });
  const { token } = (
    await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'a long password' } })
  ).body as { token: string };
  return { token, id: (created.body as { id: string }).id };
}

/** A group made by `owner`, which `other` has joined through an invitation: the group's id, which its request answered. */
async function deletionGroup(owner: { token: string }, other: { token: string }): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
    id: string;
  };
  await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: other.token });
  return id;
}

/** Request 35 over the pair: a deleted account is read in Ledger by the id its sign-up answered, and refused in a new split by the one name. */
describe('Groups → Ledger, a deleted account (request 35)', () => {
  it('reads the deleted member by the id its sign-up answered, and refuses it in a new split by AccountDeleted', async () => {
    const ann = await deletionPerson('Ann');
    const cy = await deletionPerson('Cy');
    const groupId = await deletionGroup(ann, cy);
    // Ann pays 100, split between them: Cy owes Ann 50.
    const paid = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 100, date: '2020-01-15', splitBetween: [ann.id, cy.id] },
      token: ann.token,
    });
    expect(paid.status).toBeLessThan(300);

    expect((await http.request('DELETE', `${api}/accounts/me`, { token: cy.token })).status).toBe(204);

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.find(balance => balance.memberId === cy.id)?.balance).toBe(-50);
    expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Taxi', amount: 10, date: '2020-01-16', splitBetween: [ann.id, cy.id] },
      token: ann.token,
    });
    expect((refused.body as { type: string }).type).toBe('AccountDeleted');
  });
});
