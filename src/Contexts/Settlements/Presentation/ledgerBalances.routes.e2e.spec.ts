import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-ledger-balances-${randomUUID()}.db`);

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

const PASSWORD = 'a-good-password';

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, joiner: { token: string }): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: joiner.token,
  });
  return groupId;
}

describe('Ledger → Settlements (GroupBalances)', () => {
  it('counts an expense Ledger recorded as what a member owes, so a settlement above it is refused and one within it is kept', async () => {
    const ann = await signedIn('ledger-balances-ann@example.com', 'Ann');
    const bob = await signedIn('ledger-balances-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, bob);

    // Ann paid 60.00 split equally with Bob: Bob owes 30.00 (3000), read by Settlements from Ledger's balances.
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 6000, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
    });
    const expenseId = (expense.body as { id: string }).id;
    const recorded = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token });
    expect(recorded.body).toMatchObject({ id: expenseId, amount: 6000 });

    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 3001 },
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'SettlementExceedsDebt' });

    const kept = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 3000 },
    });
    expect(kept.status).toBeLessThan(300);
  });
});
