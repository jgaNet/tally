import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Split templates, over HTTP (request 25): a split saved under a name by a member, listed, replaced and removed by the member who saved
 * it or the owner, and an expense split by one of them, as if its split had been given, keeping its shares. Every answer is held to the
 * API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-templates-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

type Person = { token: string; id: string };

let accountCount = 0;
async function signedInPerson(name: string): Promise<Person> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A group owned by Ada, which Grace, Linus and Bea joined. */
async function groupOfFour() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const bea = await signedInPerson('Bea');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus, bea]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return { ada, grace, linus, bea, groupId };
}

const saveTemplate = (groupId: string, body: unknown, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/templates`, { body, token });
const listTemplates = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/templates`, { token });
const replaceTemplate = (id: string, body: unknown, token?: string) =>
  http.request('PUT', `${api}/templates/${id}`, { body, token });
const removeTemplate = (id: string, token?: string) => http.request('DELETE', `${api}/templates/${id}`, { token });
const record = (groupId: string, body: Record<string, unknown>, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const editExpense = (id: string, body: Record<string, unknown>, token: string) =>
  http.request('PUT', `${api}/expenses/${id}`, { body, token });
const expenseOf = (id: string, token: string) => http.request('GET', `${api}/expenses/${id}`, { token });

/** A day that is past whatever today is, so that an expense recorded on it is never after today (request 4). */
const DAY = '2026-01-15';

describe('saving a template', () => {
  it('saves a split by equal members or by shares under a name, and lists it with the split as it was given', async () => {
    const { ada, grace, linus, groupId } = await groupOfFour();
    const first = await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] }, grace.token);
    expect(first.status).toBe(201);
    const second = await saveTemplate(
      groupId,
      {
        name: 'Big room',
        splitByShares: [
          { memberId: ada.id, shares: 2 },
          { memberId: linus.id, shares: 1 },
        ],
      },
      grace.token,
    );
    expect(second.status).toBe(201);

    const listed = await listTemplates(groupId, linus.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      { id: (first.body as { id: string }).id, groupId, name: 'Flat', splitBetween: [ada.id, grace.id] },
      {
        id: (second.body as { id: string }).id,
        groupId,
        name: 'Big room',
        splitByShares: [
          { memberId: ada.id, shares: 2 },
          { memberId: linus.id, shares: 1 },
        ],
      },
    ]);
  });

  it('refuses a name another template of the group has, whatever its case, and a name that is blank', async () => {
    const { ada, grace, groupId } = await groupOfFour();
    await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id] }, grace.token);
    const taken = await saveTemplate(groupId, { name: 'FLAT', splitBetween: [ada.id] }, grace.token);
    expect(taken.status).toBe(400);
    expect((taken.body as { type: string }).type).toBe('TemplateNameTaken');
    expect((await saveTemplate(groupId, { name: '   ', splitBetween: [ada.id] }, grace.token)).status).toBe(400);
  });

  it('refuses a body with neither split, both, an exact split, or a member who is not in the group', async () => {
    const { ada, grace, groupId } = await groupOfFour();
    const shaped = [
      { name: 'Neither' },
      { name: 'Both', splitBetween: [ada.id], splitByShares: [{ memberId: ada.id, shares: 1 }] },
      { name: 'Exact', splitExactly: [{ memberId: ada.id, amount: 10 }] },
    ];
    for (const body of shaped) {
      expect((await saveTemplate(groupId, body, grace.token)).status).toBe(400);
    }
    const outsider = await saveTemplate(groupId, { name: 'Outsider', splitBetween: [ada.id, 'mallory'] }, grace.token);
    expect(outsider.status).toBe(400);
    expect((outsider.body as { type: string }).type).toBe('SplitMemberNotInGroup');
  });

  it('refuses a caller who is not a member of the group, as for a group that does not exist', async () => {
    const { ada, groupId } = await groupOfFour();
    const stranger = await signedInPerson('Stranger');
    const answer = await saveTemplate(groupId, { name: 'Mine', splitBetween: [ada.id] }, stranger.token);
    expect(answer.status).toBe(404);
  });
});

describe('replacing and removing a template', () => {
  it('lets the member who saved it, or the owner, replace it, and refuses any other member', async () => {
    const { ada, grace, linus, groupId } = await groupOfFour();
    const { body } = await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id] }, grace.token);
    const id = (body as { id: string }).id;

    expect((await replaceTemplate(id, { name: 'Flat', splitBetween: [ada.id] }, linus.token)).status).toBe(403);
    expect((await replaceTemplate(id, { name: 'Flat 2', splitBetween: [ada.id, grace.id] }, grace.token)).status).toBe(
      204,
    );
    expect((await replaceTemplate(id, { name: 'Flat 3', splitBetween: [ada.id] }, ada.token)).status).toBe(204);
    expect(((await listTemplates(groupId, ada.token)).body as { name: string }[])[0].name).toBe('Flat 3');
  });

  it('lets the owner remove a template another member saved, and refuses removing one twice', async () => {
    const { ada, grace, linus, groupId } = await groupOfFour();
    const { body } = await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id] }, grace.token);
    const id = (body as { id: string }).id;

    expect((await removeTemplate(id, linus.token)).status).toBe(403);
    expect((await removeTemplate(id, ada.token)).status).toBe(204);
    expect((await removeTemplate(id, ada.token)).status).toBe(404);
    expect(((await listTemplates(groupId, ada.token)).body as unknown[]).length).toBe(0);
  });
});

describe('splitting an expense by a template', () => {
  it('splits it as the template gave it, keeping its shares, and changing or removing the template changes none', async () => {
    const { ada, grace, linus, groupId } = await groupOfFour();
    const { body } = await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] }, grace.token);
    const templateId = (body as { id: string }).id;

    const recorded = await record(
      groupId,
      { description: 'Rent', amount: 1001, date: DAY, template: templateId },
      ada.token,
    );
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;
    const expense = (await expenseOf(expenseId, linus.token)).body as {
      splitKind: string;
      shares: { memberId: string; amount: number }[];
    };
    expect(expense.splitKind).toBe('equal');
    expect(expense.shares).toEqual([
      { memberId: ada.id, amount: 501 },
      { memberId: grace.id, amount: 500 },
    ]);

    await replaceTemplate(
      templateId,
      { name: 'Other', splitByShares: [{ memberId: linus.id, shares: 1 }] },
      grace.token,
    );
    await removeTemplate(templateId, grace.token);
    const after = (await expenseOf(expenseId, linus.token)).body as typeof expense;
    expect(after.shares).toEqual(expense.shares);
  });

  it('splits by shares as a template by shares gives, and refuses a template of another group', async () => {
    const { ada, grace, linus, groupId } = await groupOfFour();
    const { body } = await saveTemplate(
      groupId,
      {
        name: 'Shares',
        splitByShares: [
          { memberId: ada.id, shares: 1 },
          { memberId: linus.id, shares: 3 },
        ],
      },
      grace.token,
    );
    const templateId = (body as { id: string }).id;
    const recorded = await record(
      groupId,
      { description: 'Gas', amount: 400, date: DAY, template: templateId },
      ada.token,
    );
    const expense = (await expenseOf((recorded.body as { id: string }).id, linus.token)).body as {
      splitKind: string;
      shares: { memberId: string; amount: number }[];
    };
    expect(expense.splitKind).toBe('shares');
    expect(expense.shares).toEqual([
      { memberId: ada.id, amount: 100 },
      { memberId: linus.id, amount: 300 },
    ]);

    const other = await groupOfFour();
    const elsewhere = await record(
      other.groupId,
      { description: 'Gas', amount: 400, date: DAY, template: templateId },
      other.ada.token,
    );
    expect(elsewhere.status).toBe(404);
  });

  it('refuses a template with a member who has left the group, and gives an expense exactly one split or template', async () => {
    const { ada, grace, linus, groupId } = await groupOfFour();
    const { body } = await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id, linus.id] }, grace.token);
    const templateId = (body as { id: string }).id;
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: linus.token })).status).toBe(204);

    const refused = await record(
      groupId,
      { description: 'Rent', amount: 100, date: DAY, template: templateId },
      ada.token,
    );
    expect(refused.status).toBe(400);
    expect((refused.body as { type: string }).type).toBe('SplitMemberNotInGroup');
    expect(((await listTemplates(groupId, ada.token)).body as unknown[]).length).toBe(1);

    const both = await record(
      groupId,
      { description: 'Rent', amount: 100, date: DAY, template: templateId, splitBetween: [ada.id] },
      ada.token,
    );
    expect(both.status).toBe(400);
  });

  it('is edited by a template too, from the version its author read', async () => {
    const { ada, grace, groupId } = await groupOfFour();
    const { body } = await saveTemplate(groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] }, grace.token);
    const templateId = (body as { id: string }).id;
    const recorded = await record(
      groupId,
      { description: 'Rent', amount: 100, date: DAY, splitBetween: [ada.id] },
      ada.token,
    );
    const expenseId = (recorded.body as { id: string }).id;

    const edited = await editExpense(
      expenseId,
      { description: 'Rent', amount: 100, date: DAY, template: templateId, version: 1 },
      ada.token,
    );
    expect(edited.status).toBe(204);
    const expense = (await expenseOf(expenseId, ada.token)).body as { shares: { memberId: string; amount: number }[] };
    expect(expense.shares.map(share => share.memberId).sort()).toEqual([ada.id, grace.id].sort());
  });
});
