import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('audit');

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
const PAST = '2026-01-10';

type Entry = { id: string; at: string; by: string; action: string; subjectId: string; amount: number };

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

const readAudit = (groupId: string, token?: string) => http.request('GET', `${api}/groups/${groupId}/audit`, { token });

describe('the audit of a group (request 28)', () => {
  it('has an entry for each change of money, written with it, the oldest first; a refused change has none', async () => {
    const ada = await signedIn('audit-ada@example.com', 'Ada');
    const bob = await signedIn('audit-bob@example.com', 'Bob');
    const cy = await signedIn('audit-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);

    const dinner = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Dinner', amount: 60, date: PAST, splitBetween: [ada.id, bob.id] },
        token: ada.token,
      })
    ).body as { id: string };
    const edited = await http.request('PUT', `${api}/expenses/${dinner.id}`, {
      body: { description: 'Dinner', amount: 90, date: PAST, splitBetween: [ada.id, bob.id], version: 1 },
      token: ada.token,
    });
    expect(edited.status).toBeLessThan(300);

    const taxi = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Taxi', amount: 30, date: PAST, splitBetween: [cy.id, bob.id] },
        token: cy.token,
      })
    ).body as { id: string };

    // Refused: bob is neither the payer of the taxi nor the owner, so nothing is written.
    const refused = await http.request('DELETE', `${api}/expenses/${taxi.id}`, { token: bob.token });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const deleted = await http.request('DELETE', `${api}/expenses/${dinner.id}`, { token: ada.token });
    expect(deleted.status).toBeLessThan(300);

    // Cy is owed 15 for the taxi and bob owes it; bob pays 10 in cash, recorded by its payee.
    const cash = (
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: bob.id, amount: 10 },
        token: cy.token,
      })
    ).body as { id: string };

    // Bob owes 5 when he leaves, and the 5 passes to the owner.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBeLessThan(300);

    const entries = (await readAudit(groupId, ada.token)).body as Entry[];
    expect(entries.map(({ action, by, subjectId, amount }) => ({ action, by, subjectId, amount }))).toEqual([
      { action: 'expense-recorded', by: ada.id, subjectId: dinner.id, amount: 60 },
      { action: 'expense-edited', by: ada.id, subjectId: dinner.id, amount: 90 },
      { action: 'expense-recorded', by: cy.id, subjectId: taxi.id, amount: 30 },
      { action: 'expense-deleted', by: ada.id, subjectId: dinner.id, amount: 90 },
      { action: 'settlement-paid', by: cy.id, subjectId: cash.id, amount: 10 },
      { action: 'balance-passed', by: bob.id, subjectId: bob.id, amount: -5 },
    ]);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(entries.every(entry => !Number.isNaN(Date.parse(entry.at)))).toBe(true);
  });

  it('is read by a member of the group only: for anyone else the group does not exist', async () => {
    const ada = await signedIn('audit-ada-2@example.com', 'Ada');
    const outsider = await signedIn('audit-out@example.com', 'Out');
    const groupId = await groupWith(ada, []);

    expect((await readAudit(groupId, outsider.token)).status).toBe(404);
    expect((await readAudit(groupId, ada.token)).body).toEqual([]);
    expect((await readAudit(groupId)).status).toBe(401);
  });
});

describe('Settlements → Ledger (SettlementAudit)', () => {
  it('finds the settlement a cash request answered, in the audit, by the id that request answered', async () => {
    const ada = await signedIn('audit-ada-s@example.com', 'Ada');
    const bob = await signedIn('audit-bob-s@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 40, date: PAST, splitBetween: [ada.id, bob.id] },
      token: ada.token,
    });

    const cash = (
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: bob.id, amount: 20 },
        token: ada.token,
      })
    ).body as { id: string };

    const entries = (await readAudit(groupId, ada.token)).body as Entry[];
    expect(entries.find(entry => entry.subjectId === cash.id)).toMatchObject({
      action: 'settlement-paid',
      by: ada.id,
      amount: 20,
    });
  });
});

describe('Groups → Ledger (PassedBalances)', () => {
  it('finds the balance a leave passed, in the audit, by the member who left', async () => {
    const ada = await signedIn('audit-ada-g@example.com', 'Ada');
    const bob = await signedIn('audit-bob-g@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Snacks', amount: 40, date: PAST, splitBetween: [ada.id, bob.id] },
      token: ada.token,
    });

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBeLessThan(300);

    const entries = (await readAudit(groupId, ada.token)).body as Entry[];
    expect(entries.find(entry => entry.action === 'balance-passed' && entry.subjectId === bob.id)).toMatchObject({
      by: bob.id,
      amount: -20,
    });
  });
});
