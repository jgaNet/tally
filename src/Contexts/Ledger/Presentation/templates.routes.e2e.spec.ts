import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('templates');

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';
const DAY = '2026-01-10';

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const saveTemplate = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/templates`, { body, token });
const replaceTemplate = (token: string, id: string, body: unknown) =>
  http.request('PUT', `${api}/templates/${id}`, { body, token });
const removeTemplate = (token: string, id: string) => http.request('DELETE', `${api}/templates/${id}`, { token });
const listTemplates = (token: string, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/templates`, { token });
const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readExpense = (token: string, id: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const members = async (token: string, groupId: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/members`, { token })).body as Array<{ memberId: string }>;

type Shares = Array<{ memberId: string; amount: number }>;
type Template = {
  id: string;
  groupId: string;
  name: string;
  splitBetween?: string[];
  splitByShares?: Array<{ memberId: string; shares: number }>;
};

describe('split templates (request 25)', () => {
  it('saves a template, lists it earliest first, and refuses a name another template of the group has, whatever its case', async () => {
    const ada = await signedIn('tpl-ada@example.com', 'Ada');
    const bob = await signedIn('tpl-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const [adaId, bobId] = (await members(ada.token, groupId)).map(member => member.memberId);

    const first = await saveTemplate(ada.token, groupId, {
      name: 'Rent',
      splitByShares: [
        { memberId: adaId, shares: 2 },
        { memberId: bobId, shares: 1 },
      ],
    });
    expect(first.status).toBe(201);
    const second = await saveTemplate(bob.token, groupId, { name: 'Food', splitBetween: [adaId, bobId] });
    expect(second.status).toBe(201);

    expect((await saveTemplate(bob.token, groupId, { name: '  rENT ', splitBetween: [adaId] })).status).toBe(409);

    const listed = (await listTemplates(bob.token, groupId)).body as Template[];
    expect(listed.map(template => template.name)).toEqual(['Rent', 'Food']);
    expect(listed[0]).toEqual({
      id: (first.body as { id: string }).id,
      groupId,
      name: 'Rent',
      splitByShares: [
        { memberId: adaId, shares: 2 },
        { memberId: bobId, shares: 1 },
      ],
    });
    expect(listed[1].splitBetween).toEqual([adaId, bobId]);
  });

  it('refuses a template of the wrong shape with 400, and one whose split does not fit the group with 422', async () => {
    const ada = await signedIn('tpl-shape-ada@example.com', 'Ada');
    const bob = await signedIn('tpl-shape-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const [adaId, bobId] = (await members(ada.token, groupId)).map(member => member.memberId);

    expect((await saveTemplate(ada.token, groupId, { name: 'Neither' })).status).toBe(400);
    expect(
      (
        await saveTemplate(ada.token, groupId, {
          name: 'Both',
          splitBetween: [adaId],
          splitByShares: [{ memberId: adaId, shares: 1 }],
        })
      ).status,
    ).toBe(400);
    expect((await saveTemplate(ada.token, groupId, { name: '   ', splitBetween: [adaId] })).status).toBe(422);
    expect((await saveTemplate(ada.token, groupId, { name: 'Twice', splitBetween: [adaId, adaId] })).status).toBe(422);
    expect(
      (await saveTemplate(ada.token, groupId, { name: 'Zero', splitByShares: [{ memberId: bobId, shares: 0 }] }))
        .status,
    ).toBe(422);
    expect((await saveTemplate(ada.token, groupId, { name: 'Stranger', splitBetween: [adaId, 'nobody'] })).status).toBe(
      422,
    );
    expect((await saveTemplate(ada.token, groupId, { name: 'Nobody', splitBetween: [] })).status).toBe(422);
  });

  it('refuses a stranger with 404, and replaces or removes a template only for its author or the owner', async () => {
    const owner = await signedIn('tpl-own-owner@example.com', 'Owner');
    const author = await signedIn('tpl-own-author@example.com', 'Author');
    const other = await signedIn('tpl-own-other@example.com', 'Other');
    const stranger = await signedIn('tpl-own-stranger@example.com', 'Stranger');
    const groupId = await groupWith(owner, [author, other]);
    const [ownerId, authorId, otherId] = (await members(owner.token, groupId)).map(member => member.memberId);

    expect((await saveTemplate(stranger.token, groupId, { name: 'Mine', splitBetween: [ownerId] })).status).toBe(404);

    const made = await saveTemplate(author.token, groupId, { name: 'Taxi', splitBetween: [authorId, otherId] });
    const id = (made.body as { id: string }).id;
    expect((await replaceTemplate(other.token, id, { name: 'Taxi', splitBetween: [otherId] })).status).toBe(403);
    expect((await removeTemplate(other.token, id)).status).toBe(403);
    expect((await replaceTemplate(stranger.token, id, { name: 'Taxi', splitBetween: [authorId] })).status).toBe(404);

    expect(
      (await replaceTemplate(author.token, id, { name: 'Cab', splitBetween: [authorId, otherId, ownerId] })).status,
    ).toBe(204);
    expect(((await listTemplates(owner.token, groupId)).body as Template[])[0]).toMatchObject({
      id,
      name: 'Cab',
      splitBetween: [authorId, otherId, ownerId],
    });

    expect((await replaceTemplate(owner.token, id, { name: 'Taxi', splitBetween: [authorId] })).status).toBe(204);
    expect((await removeTemplate(owner.token, id)).status).toBe(204);
    expect((await listTemplates(owner.token, groupId)).body).toEqual([]);
    expect((await removeTemplate(owner.token, id)).status).toBe(404);
  });

  it('refuses a rename to another template of the group, and keeps a name its own when only its case changes', async () => {
    const ada = await signedIn('tpl-rename-ada@example.com', 'Ada');
    const bob = await signedIn('tpl-rename-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const [adaId] = (await members(ada.token, groupId)).map(member => member.memberId);
    const one = (await saveTemplate(ada.token, groupId, { name: 'Gas', splitBetween: [adaId] })).body as { id: string };
    await saveTemplate(ada.token, groupId, { name: 'Water', splitBetween: [adaId] });

    expect((await replaceTemplate(ada.token, one.id, { name: 'water', splitBetween: [adaId] })).status).toBe(409);
    expect((await replaceTemplate(ada.token, one.id, { name: 'GAS', splitBetween: [adaId] })).status).toBe(204);
  });

  it('splits an expense by a template as if its split had been given, and keeps its shares when the template changes', async () => {
    const ada = await signedIn('tpl-expense-ada@example.com', 'Ada');
    const bob = await signedIn('tpl-expense-bob@example.com', 'Bob');
    const cy = await signedIn('tpl-expense-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);
    const [adaId, bobId, cyId] = (await members(ada.token, groupId)).map(member => member.memberId);

    const flat = (
      await saveTemplate(ada.token, groupId, {
        name: 'Flat',
        splitByShares: [
          { memberId: adaId, shares: 2 },
          { memberId: bobId, shares: 2 },
          { memberId: cyId, shares: 1 },
        ],
      })
    ).body as { id: string };

    const recorded = await record(ada.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: DAY,
      template: flat.id,
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;
    const before = (await readExpense(ada.token, expenseId)).body as {
      splitKind: string;
      shares: Shares;
      amount: number;
    };
    expect(before.splitKind).toBe('shares');
    expect(before.shares).toEqual([
      { memberId: adaId, amount: 400 },
      { memberId: bobId, amount: 400 },
      { memberId: cyId, amount: 200 },
    ]);

    expect((await replaceTemplate(ada.token, flat.id, { name: 'Flat', splitBetween: [adaId] })).status).toBe(204);
    expect((await removeTemplate(ada.token, flat.id)).status).toBe(204);
    expect(((await readExpense(ada.token, expenseId)).body as { shares: Shares }).shares).toEqual(before.shares);

    const equal = (await saveTemplate(ada.token, groupId, { name: 'Trio', splitBetween: [adaId, bobId, cyId] }))
      .body as {
      id: string;
    };
    const second = await record(bob.token, groupId, {
      description: 'Rent',
      amount: 1000,
      date: DAY,
      template: equal.id,
    });
    expect(second.status).toBe(201);
    const split = (await readExpense(bob.token, (second.body as { id: string }).id)).body as {
      splitKind: string;
      shares: Shares;
    };
    expect(split.splitKind).toBe('equal');
    expect(split.shares).toEqual([
      { memberId: adaId, amount: 334 },
      { memberId: bobId, amount: 333 },
      { memberId: cyId, amount: 333 },
    ]);
  });

  it('refuses an expense that gives a template with a split, or none, with 400, and a template of another group with 404', async () => {
    const ada = await signedIn('tpl-refuse-ada@example.com', 'Ada');
    const bob = await signedIn('tpl-refuse-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const elsewhere = await groupWith(bob, []);
    const [adaId] = (await members(ada.token, groupId)).map(member => member.memberId);
    const own = (await saveTemplate(ada.token, groupId, { name: 'Own', splitBetween: [adaId] })).body as { id: string };
    const foreign = (await saveTemplate(bob.token, elsewhere, { name: 'Theirs', splitBetween: [bob.id] })).body as {
      id: string;
    };

    const base = { description: 'Snacks', amount: 500, date: DAY };
    expect((await record(ada.token, groupId, { ...base, template: own.id, splitBetween: [adaId] })).status).toBe(400);
    expect((await record(ada.token, groupId, base)).status).toBe(400);
    expect((await record(ada.token, groupId, { ...base, template: foreign.id })).status).toBe(404);
    expect((await record(ada.token, groupId, { ...base, template: 'no-such-template' })).status).toBe(404);
  });

  it('refuses an expense whose template names a member who has left, or whose payer it does not name', async () => {
    const ada = await signedIn('tpl-left-ada@example.com', 'Ada');
    const bob = await signedIn('tpl-left-bob@example.com', 'Bob');
    const cy = await signedIn('tpl-left-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);
    const [adaId, bobId, cyId] = (await members(ada.token, groupId)).map(member => member.memberId);
    const withCy = (await saveTemplate(ada.token, groupId, { name: 'With Cy', splitBetween: [adaId, bobId, cyId] }))
      .body as {
      id: string;
    };
    const withoutAda = (await saveTemplate(ada.token, groupId, { name: 'Without Ada', splitBetween: [bobId] }))
      .body as {
      id: string;
    };

    expect(
      (await record(ada.token, groupId, { description: 'Gift', amount: 300, date: DAY, template: withoutAda.id }))
        .status,
    ).toBe(422);

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: cy.token })).status).toBe(204);
    expect(
      (await record(ada.token, groupId, { description: 'Gift', amount: 300, date: DAY, template: withCy.id })).status,
    ).toBe(422);
    // The template is kept: it is still listed, and it still splits nothing for anyone who is not a member.
    expect(((await listTemplates(ada.token, groupId)).body as Template[]).map(template => template.id)).toContain(
      withCy.id,
    );
  });
});

describe('Groups → Ledger', () => {
  it('saves a template in the group Groups made, naming a member who has just joined, and splits an expense by it at once', async () => {
    const ada = await signedIn('tg-ada@example.com', 'Ada');
    const bob = await signedIn('tg-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    // Bob has just joined: the membership Groups committed is the one the template and the split are checked against (T3, ADR 4).
    const saved = await saveTemplate(bob.token, groupId, { name: 'Dinner', splitBetween: [bob.id, ada.id] });
    expect(saved.status).toBe(201);
    const templateId = (saved.body as { id: string }).id;
    const listed = (await listTemplates(ada.token, groupId)).body as Template[];
    expect(listed.find(template => template.id === templateId)).toEqual({
      id: templateId,
      groupId,
      name: 'Dinner',
      splitBetween: [bob.id, ada.id],
    });

    const recorded = await record(bob.token, groupId, {
      description: 'Dinner',
      amount: 90,
      date: DAY,
      template: templateId,
    });
    expect(recorded.status).toBe(201);
    const read = await readExpense(ada.token, (recorded.body as { id: string }).id);
    expect(read.body).toMatchObject({
      groupId,
      paidBy: bob.id,
      splitKind: 'equal',
      shares: [
        { memberId: bob.id, amount: 45 },
        { memberId: ada.id, amount: 45 },
      ],
    });
  });
});
