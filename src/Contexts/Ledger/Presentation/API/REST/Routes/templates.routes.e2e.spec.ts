import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-template-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Has `joiner` join the group `owner` invites them to. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Creates a group with its owner, and has the others join it: answers the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (
    (await outcome((answer.body as Body).operationId as string, owner.token)).body as {
      result: { id: string };
    }
  ).result.id;
  for (const other of others) await join(groupId, owner, other);
  return groupId;
}

/** Saves a template, answering the outcome of the command. */
async function saveTemplate(groupId: string, token: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/templates`, { body, token });
  return answer.status === 202
    ? outcome((answer.body as Body).operationId as string, token)
    : { status: answer.status, body: answer.body as Body };
}

/** The error type of an operation that ended in ERROR, or null when it did not. */
function errorTypeOf(result: { body: Body }) {
  return ((result.body.error as { type?: string } | undefined) ?? { type: null }).type ?? null;
}

describe('split templates (request 25)', () => {
  it('saves a template and lists it, the earliest saved first, with its split as it was given', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await groupWith(ann, [bob]);

    const first = await saveTemplate(groupId, ann.token, { name: 'Flat', splitBetween: [ann.id, bob.id] });
    expect(first.body.status).toBe('SUCCESS');
    const second = await saveTemplate(groupId, bob.token, {
      name: 'Big room',
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });
    expect(second.body.status).toBe('SUCCESS');

    const listed = await http.get(`${api}/groups/${groupId}/templates`, { token: bob.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      { id: (first.body.result as { id: string }).id, groupId, name: 'Flat', splitBetween: [ann.id, bob.id] },
      {
        id: (second.body.result as { id: string }).id,
        groupId,
        name: 'Big room',
        splitByShares: [
          { memberId: ann.id, shares: 2 },
          { memberId: bob.id, shares: 1 },
        ],
      },
    ]);
  });

  it('refuses a name a template of the group has already, whatever its case', async () => {
    const ann = await person('Ann');
    const groupId = await groupWith(ann, []);
    const first = await saveTemplate(groupId, ann.token, { name: 'Rent', splitBetween: [ann.id] });
    expect(first.body.status).toBe('SUCCESS');

    const taken = await saveTemplate(groupId, ann.token, { name: 'RENT', splitBetween: [ann.id] });
    expect(errorTypeOf(taken)).toBe('TemplateNameTaken');
  });

  it('refuses a template that is both or neither of its two splits, and one that lists a non-member', async () => {
    const ann = await person('Ann');
    const groupId = await groupWith(ann, []);

    const both = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      body: { name: 'Both', splitBetween: [ann.id], splitByShares: [{ memberId: ann.id, shares: 1 }] },
      token: ann.token,
    });
    expect(both.status).toBe(400);
    const neither = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      body: { name: 'Neither' },
      token: ann.token,
    });
    expect(neither.status).toBe(400);

    const outsider = await saveTemplate(groupId, ann.token, { name: 'Outsider', splitBetween: [ann.id, 'nobody'] });
    expect(errorTypeOf(outsider)).toBe('NotAGroupMember');
  });

  it('splits an expense by a template as if its split had been given, and keeps its shares when the template changes', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await groupWith(ann, [bob]);
    const saved = await saveTemplate(groupId, ann.token, {
      name: 'Shares',
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });
    const templateId = (saved.body.result as { id: string }).id;

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Groceries', amount: 900, date: '2026-11-01', template: templateId },
      token: ann.token,
    });
    const expense = await outcome((recorded.body as Body).operationId as string, ann.token);
    expect(expense.body.status).toBe('SUCCESS');
    const expenseId = (expense.body.result as { id: string }).id;

    const replaced = await http.request('PUT', `${api}/templates/${templateId}`, {
      body: { name: 'Shares', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    await outcome((replaced.body as Body).operationId as string, ann.token);

    const read = await http.get(`${api}/expenses/${expenseId}`, { token: ann.token });
    expect(read.body).toMatchObject({
      splitKind: 'shares',
      amount: 900,
      paidBy: ann.id,
      shares: [
        { memberId: ann.id, amount: 600 },
        { memberId: bob.id, amount: 300 },
      ],
    });
  });

  it('refuses an expense that gives a template and a split of its own, and a template of another group', async () => {
    const ann = await person('Ann');
    const groupId = await groupWith(ann, []);
    const otherGroup = await groupWith(ann, []);
    const saved = await saveTemplate(groupId, ann.token, { name: 'Solo', splitBetween: [ann.id] });
    const templateId = (saved.body.result as { id: string }).id;

    const both = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Both',
        amount: 100,
        date: '2026-11-01',
        template: templateId,
        splitBetween: [ann.id],
      },
      token: ann.token,
    });
    expect(both.status).toBe(400);

    const elsewhere = await http.request('POST', `${api}/groups/${otherGroup}/expenses`, {
      body: { description: 'Elsewhere', amount: 100, date: '2026-11-01', template: templateId },
      token: ann.token,
    });
    const refused = await outcome((elsewhere.body as Body).operationId as string, ann.token);
    expect(refused.body.status).toBe('ERROR');
    expect(errorTypeOf(refused)).not.toBeNull();
  });

  it('lets only the member who saved a template, or the owner, change or remove it', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await groupWith(ann, [bob, cy]);
    const saved = await saveTemplate(groupId, bob.token, { name: 'Bob flat', splitBetween: [ann.id, bob.id] });
    const templateId = (saved.body.result as { id: string }).id;

    const byCy = await http.request('PUT', `${api}/templates/${templateId}`, {
      body: { name: 'Cy flat', splitBetween: [ann.id, bob.id, cy.id] },
      token: cy.token,
    });
    expect(errorTypeOf({ body: (await outcome((byCy.body as Body).operationId as string, cy.token)).body })).toBe(
      'NotAllowedToChangeTemplate',
    );

    const removedByCy = await http.request('DELETE', `${api}/templates/${templateId}`, { token: cy.token });
    expect(
      errorTypeOf({ body: (await outcome((removedByCy.body as Body).operationId as string, cy.token)).body }),
    ).toBe('NotAllowedToChangeTemplate');

    const removedByOwner = await http.request('DELETE', `${api}/templates/${templateId}`, { token: ann.token });
    expect((await outcome((removedByOwner.body as Body).operationId as string, ann.token)).body.status).toBe('SUCCESS');
    const listed = await http.get(`${api}/groups/${groupId}/templates`, { token: ann.token });
    expect(listed.body).toEqual([]);
  });
});
