import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Split templates, end to end (request 25): the application booted in this process, spoken to over HTTP, every answer held to
 * api/25-split-templates.yaml by the client. The day is the server's, as its own Date header says.
 */
const PASSWORD = 'correct horse';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  app = await createApplication({ jobsIntervalSeconds: 0.05 });
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

let counter = 0;
const uniqueEmail = (name: string) => `${name}.${++counter}.${Math.random().toString(36).slice(2)}@example.com`;

/** A EUR group of three: the owner Ana, and Ben and Cy, who joined it. */
async function groupOfThree() {
  const ana = await accountOf(uniqueEmail('ana'), 'Ana');
  const ben = await accountOf(uniqueEmail('ben'), 'Ben');
  const cy = await accountOf(uniqueEmail('cy'), 'Cy');
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: ana.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const member of [ben, cy]) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: ana.token });
    await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: member.token,
    });
  }
  return { ana, ben, cy, groupId };
}

/** The server's today, as a date of the expense. */
async function todayOf(token: string): Promise<string> {
  const answer = await http.get('/v1/accounts/me', { token });
  return new Date(answer.headers.get('date') ?? '').toISOString().slice(0, 10);
}

describe('split templates', () => {
  it('a member saves a template, lists it with its split as given, and the owner removes it', async () => {
    const { ana, ben, groupId } = await groupOfThree();

    const saved = await http.request('POST', `/v1/groups/${groupId}/templates`, {
      body: { name: 'Flat', splitBetween: [ana.id, ben.id] },
      token: ben.token,
    });
    expect(saved.status).toBe(201);
    const templateId = (saved.body as { id: string }).id;

    const listed = await http.get(`/v1/groups/${groupId}/templates`, { token: ana.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([{ id: templateId, groupId, name: 'Flat', splitBetween: [ana.id, ben.id] }]);

    const removed = await http.request('DELETE', `/v1/templates/${templateId}`, { token: ana.token });
    expect(removed.status).toBe(201);
    const after = await http.get(`/v1/groups/${groupId}/templates`, { token: ana.token });
    expect(after.body).toEqual([]);
  });

  it('refuses a second template of the same name, whatever its case, with a conflict', async () => {
    const { ana, groupId } = await groupOfThree();
    await http.request('POST', `/v1/groups/${groupId}/templates`, {
      body: { name: 'Rent', splitBetween: [ana.id] },
      token: ana.token,
    });
    const again = await http.request('POST', `/v1/groups/${groupId}/templates`, {
      body: { name: 'RENT', splitBetween: [ana.id] },
      token: ana.token,
    });
    expect(again.status).toBe(409);
    expect((again.body as { type: string }).type).toBe('DuplicateTemplateName');
  });

  it('splits an expense by a template: the expense keeps its shares and how it was split', async () => {
    const { ana, ben, cy, groupId } = await groupOfThree();
    const saved = await http.request('POST', `/v1/groups/${groupId}/templates`, {
      body: {
        name: 'Big room',
        splitByShares: [
          { memberId: ana.id, shares: 2 },
          { memberId: ben.id, shares: 2 },
          { memberId: cy.id, shares: 1 },
        ],
      },
      token: ana.token,
    });
    const templateId = (saved.body as { id: string }).id;
    const date = await todayOf(ana.token);

    const recorded = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Rent', amount: 1000, date, template: templateId },
      token: ana.token,
    });
    expect(recorded.status).toBe(201);
    const expense = await http.get(`/v1/expenses/${(recorded.body as { id: string }).id}`, { token: ana.token });
    expect(expense.body).toMatchObject({ splitKind: 'shares', amount: 1000 });
    expect((expense.body as { shares: { amount: number }[] }).shares.map(share => share.amount)).toEqual([
      400, 400, 200,
    ]);

    // Replacing the template later changes no expense.
    await http.request('PUT', `/v1/templates/${templateId}`, {
      body: { name: 'Big room, new', splitBetween: [ana.id] },
      token: ana.token,
    });
    const again = await http.get(`/v1/expenses/${(recorded.body as { id: string }).id}`, { token: ana.token });
    expect((again.body as { shares: { amount: number }[] }).shares.map(share => share.amount)).toEqual([400, 400, 200]);
  });

  it('refuses a change by another member, and an expense naming a template the group does not have', async () => {
    const { ana, ben, cy, groupId } = await groupOfThree();
    const saved = await http.request('POST', `/v1/groups/${groupId}/templates`, {
      body: { name: 'Flat', splitBetween: [ana.id, ben.id] },
      token: ben.token,
    });
    const templateId = (saved.body as { id: string }).id;

    const byCy = await http.request('DELETE', `/v1/templates/${templateId}`, { token: cy.token });
    expect(byCy.status).toBe(403);

    const date = await todayOf(ana.token);
    const unknown = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Milk', amount: 300, date, template: 'no-such-template' },
      token: ana.token,
    });
    expect(unknown.status).toBe(404);
  });
});

describe('Groups → Ledger: a split template (request 25)', () => {
  it('saves a template for a group made in Groups under the id that group was answered, and finds it there', async () => {
    const { ana, ben, groupId } = await groupOfThree();

    const saved = await http.request('POST', `/v1/groups/${groupId}/templates`, {
      body: { name: 'Groceries', splitBetween: [ana.id, ben.id] },
      token: ana.token,
    });
    const templateId = (saved.body as { id: string }).id;

    const listed = await http.get(`/v1/groups/${groupId}/templates`, { token: ben.token });
    expect(listed.body).toEqual([{ id: templateId, groupId, name: 'Groceries', splitBetween: [ana.id, ben.id] }]);
  });
});
