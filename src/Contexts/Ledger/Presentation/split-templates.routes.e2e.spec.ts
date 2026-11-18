import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The split templates of request 25, over HTTP: a member saves a split under a name, lists the group's templates, the saver or the owner
 * replaces or removes one, and an expense is split by a template in place of its own split, keeping the shares it was decided as.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
/** A past day, so that every expense of these tests is on a real day that is not after today. */
const day = '2026-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-templates-'));
  app = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

interface Person {
  token: string;
  id: string;
}

async function person(name: string, email: string): Promise<Person> {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group of `owner`, with `others` joined. */
async function groupOf(owner: Person, others: Person[]): Promise<string> {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: owner.token,
    body: { name: 'Templates', currency: 'EUR' },
  });
  const groupId = (body as { id: string }).id;
  for (const who of others) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: who.token,
    });
  }
  return groupId;
}

/** Saves a template of a group, as `who`, and answers its id. */
async function saveTemplate(who: Person, groupId: string, body: Record<string, unknown>): Promise<string> {
  const { status, body: answer } = await http.request('POST', `${api}/groups/${groupId}/templates`, {
    token: who.token,
    body,
  });
  expect(status).toBe(201);
  return (answer as { id: string }).id;
}

describe('a member saves a split under a name and lists the group’s templates', () => {
  it('saves templates, lists them the earliest first with each split as it was given, and refuses a name taken whatever its case with 409', async () => {
    const ann = await person('Ann', 'ann@templates.example.com');
    const bob = await person('Bob', 'bob@templates.example.com');
    const groupId = await groupOf(ann, [bob]);

    const first = await saveTemplate(bob, groupId, { name: 'Rent share', splitBetween: [ann.id, bob.id] });
    const second = await saveTemplate(bob, groupId, {
      name: 'Big room',
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });

    const taken = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      token: ann.token,
      body: { name: 'BIG ROOM', splitBetween: [ann.id] },
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ type: 'TemplateNameTaken', message: expect.any(String) });

    const list = await http.request('GET', `${api}/groups/${groupId}/templates`, { token: ann.token });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      { id: first, groupId, name: 'Rent share', splitBetween: [ann.id, bob.id] },
      {
        id: second,
        groupId,
        name: 'Big room',
        splitByShares: [
          { memberId: ann.id, shares: 2 },
          { memberId: bob.id, shares: 1 },
        ],
      },
    ]);
  });

  it('refuses a template of the wrong shape with 400, and one whose name, members or shares do not hold with 422, and a stranger finds no group (404)', async () => {
    const ann = await person('Ann', 'ann@shapes.templates.example.com');
    const bob = await person('Bob', 'bob@shapes.templates.example.com');
    const eve = await person('Eve', 'eve@shapes.templates.example.com');
    const groupId = await groupOf(ann, [bob]);
    const save = (who: Person, body: Record<string, unknown>) =>
      http.request('POST', `${api}/groups/${groupId}/templates`, { token: who.token, body });

    // Neither split, or both: the shape.
    expect((await save(ann, { name: 'Neither' })).status).toBe(400);
    expect((await save(ann, { name: 'Both', splitBetween: [ann.id], splitByShares: [] })).status).toBe(400);
    // A name that is only spaces, or longer than 60 characters, a member who is not in the group, one listed twice, shares below 1.
    expect((await save(ann, { name: '   ', splitBetween: [ann.id] })).status).toBe(422);
    expect((await save(ann, { name: 'x'.repeat(61), splitBetween: [ann.id] })).status).toBe(422);
    expect((await save(ann, { name: 'Stranger', splitBetween: [ann.id, eve.id] })).status).toBe(422);
    expect((await save(ann, { name: 'Twice', splitBetween: [ann.id, ann.id] })).status).toBe(422);
    expect((await save(ann, { name: 'Zero', splitByShares: [{ memberId: ann.id, shares: 0 }] })).status).toBe(422);
    // A caller who is not in the group.
    expect((await save(eve, { name: 'Mine', splitBetween: [ann.id] })).status).toBe(404);
  });
});

describe('the one who saved a template, or the group’s owner, replaces or removes it', () => {
  it('replaces and removes a template by its saver or the owner; another member is refused with 403, a stranger finds none (404)', async () => {
    const ann = await person('Ann', 'ann@changes.templates.example.com');
    const bob = await person('Bob', 'bob@changes.templates.example.com');
    const carl = await person('Carl', 'carl@changes.templates.example.com');
    const eve = await person('Eve', 'eve@changes.templates.example.com');
    const groupId = await groupOf(ann, [bob, carl]);
    const id = await saveTemplate(bob, groupId, { name: 'Food', splitBetween: [ann.id, bob.id] });
    await saveTemplate(ann, groupId, { name: 'Other', splitBetween: [ann.id] });

    const replace = (who: Person, body: Record<string, unknown>) =>
      http.request('PUT', `${api}/templates/${id}`, { token: who.token, body });

    expect((await replace(carl, { name: 'Food', splitBetween: [carl.id] })).status).toBe(403);
    expect((await replace(eve, { name: 'Food', splitBetween: [eve.id] })).status).toBe(404);
    expect((await replace(ann, { name: 'other', splitBetween: [ann.id] })).status).toBe(409);
    expect((await replace(ann, { name: 'Groceries', splitBetween: [ann.id, bob.id, carl.id] })).status).toBe(204);
    expect((await replace(bob, { name: 'Groceries', splitBetween: [ann.id] })).status).toBe(204);

    const list = await http.request('GET', `${api}/groups/${groupId}/templates`, { token: carl.token });
    expect((list.body as { name: string }[]).map(template => template.name)).toEqual(['Groceries', 'Other']);

    expect((await http.request('DELETE', `${api}/templates/${id}`, { token: carl.token })).status).toBe(403);
    expect((await http.request('DELETE', `${api}/templates/${id}`, { token: ann.token })).status).toBe(204);
    expect((await http.request('DELETE', `${api}/templates/${id}`, { token: ann.token })).status).toBe(404);
  });
});

describe('an expense is split by a template in place of its own split', () => {
  it('splits an expense as the template’s split had been given, keeps the shares it decided, and no later change of the template changes it', async () => {
    const ann = await person('Ann', 'ann@expenses.templates.example.com');
    const bob = await person('Bob', 'bob@expenses.templates.example.com');
    const groupId = await groupOf(ann, [bob]);
    const byShares = await saveTemplate(ann, groupId, {
      name: 'Room',
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });
    const equal = await saveTemplate(ann, groupId, { name: 'Halves', splitBetween: [ann.id, bob.id] });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Room', amount: 900, date: day, template: byShares },
    });
    expect(recorded.status).toBe(201);
    const roomId = (recorded.body as { id: string }).id;
    const halves = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Shop', amount: 1001, date: day, template: equal },
    });
    const halvesId = (halves.body as { id: string }).id;

    // The shares as they were decided: 2 to 1 of 900, and the remainder of 1001 halved goes to the member listed first.
    const room = (await http.request('GET', `${api}/expenses/${roomId}`, { token: ann.token })).body as Record<
      string,
      unknown
    >;
    expect(room.splitKind).toBe('shares');
    expect(room.shares).toEqual([
      { memberId: ann.id, amount: 600 },
      { memberId: bob.id, amount: 300 },
    ]);
    const shop = (await http.request('GET', `${api}/expenses/${halvesId}`, { token: ann.token })).body as Record<
      string,
      unknown
    >;
    expect(shop.splitKind).toBe('equal');
    expect(shop.shares).toEqual([
      { memberId: ann.id, amount: 501 },
      { memberId: bob.id, amount: 500 },
    ]);

    // The template changes and goes: the expenses keep their shares.
    await http.request('PUT', `${api}/templates/${byShares}`, {
      token: ann.token,
      body: { name: 'Room', splitBetween: [bob.id] },
    });
    await http.request('DELETE', `${api}/templates/${byShares}`, { token: ann.token });
    const after = (await http.request('GET', `${api}/expenses/${roomId}`, { token: ann.token })).body as Record<
      string,
      unknown
    >;
    expect(after.shares).toEqual(room.shares);
    expect(after.splitKind).toBe('shares');
  });

  it('refuses a template of another group with 404, a payer outside the split with 422, and a body that gives a split and a template with 400', async () => {
    const ann = await person('Ann', 'ann@refusals.templates.example.com');
    const bob = await person('Bob', 'bob@refusals.templates.example.com');
    const eve = await person('Eve', 'eve@refusals.templates.example.com');
    const groupId = await groupOf(ann, [bob]);
    const otherGroup = await groupOf(eve, []);
    const ofOther = await saveTemplate(eve, otherGroup, { name: 'Theirs', splitBetween: [eve.id] });
    const onlyBob = await saveTemplate(bob, groupId, { name: 'Bob only', splitBetween: [bob.id] });

    const record = (body: Record<string, unknown>) =>
      http.request('POST', `${api}/groups/${groupId}/expenses`, {
        token: ann.token,
        body: { description: 'Test', amount: 300, date: day, ...body },
      });

    expect((await record({ template: ofOther })).status).toBe(404);
    expect((await record({ template: onlyBob })).status).toBe(422);
    expect((await record({ template: onlyBob, splitBetween: [ann.id, bob.id] })).status).toBe(400);
    expect((await record({ splitBetween: [ann.id], template: onlyBob })).status).toBe(400);
    expect((await record({})).status).toBe(400);
  });

  it('an edit takes a template too, from the version its author read', async () => {
    const ann = await person('Ann', 'ann@edits.templates.example.com');
    const bob = await person('Bob', 'bob@edits.templates.example.com');
    const groupId = await groupOf(ann, [bob]);
    const both = await saveTemplate(bob, groupId, { name: 'Both', splitBetween: [ann.id, bob.id] });
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 400, date: day, splitBetween: [ann.id] },
    });
    const expenseId = (recorded.body as { id: string }).id;

    const edited = await http.request('PUT', `${api}/expenses/${expenseId}`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 400, date: day, version: 1, template: both },
    });
    expect(edited.status).toBe(204);
    const expense = (await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token })).body as Record<
      string,
      unknown
    >;
    expect(expense.splitKind).toBe('equal');
    expect(expense.shares).toEqual([
      { memberId: ann.id, amount: 200 },
      { memberId: bob.id, amount: 200 },
    ]);
  });
});

/**
 * The relationship Groups → Ledger (GroupMembers, ADR 6): Ledger asks Groups who is in a group, through its own port. A group is made through the
 * API and its id is the one that request answered; a template is saved in it by that id, and an expense is split by the template and read back
 * by the same ids, with the members Groups answered.
 */
describe('Groups → Ledger (GroupMembers)', () => {
  it('saves a template in the group a request made, by that group id, and splits an expense by it, with the members Groups answered', async () => {
    const ann = await person('Nia', 'nia@templates-link.example.com');
    const bob = await person('Ola', 'ola@templates-link.example.com');

    const made = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Link', currency: 'CHF' },
    });
    expect(made.status).toBe(201);
    const groupId = (made.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const templateId = await saveTemplate(bob, groupId, { name: 'Link', splitBetween: [ann.id, bob.id] });
    const listed = await http.request('GET', `${api}/groups/${groupId}/templates`, { token: ann.token });
    expect(listed.body).toEqual([{ id: templateId, groupId, name: 'Link', splitBetween: [ann.id, bob.id] }]);

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Link', amount: 1000, date: day, template: templateId },
    });
    expect(recorded.status).toBe(201);
    const expense = (
      await http.request('GET', `${api}/expenses/${(recorded.body as { id: string }).id}`, { token: bob.token })
    ).body as Record<string, unknown>;
    expect(expense).toMatchObject({ groupId, paidBy: ann.id, splitKind: 'equal' });
    expect(expense.shares).toEqual([
      { memberId: ann.id, amount: 500 },
      { memberId: bob.id, amount: 500 },
    ]);
  });
});
