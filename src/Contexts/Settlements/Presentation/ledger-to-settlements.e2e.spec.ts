import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Ledger → Settlements (ADR 10): Settlements reads the balances of a group through its `IGroupBalances` port, over Ledger's
 * balances read model. Over HTTP: an expense made in Ledger keeps the id its request answered, Ledger holds it under that id,
 * and Settlements reads the group the expense was recorded in by the group's id, the transfer the expense makes among its
 * suggested settlements. Settlements has no route keyed by an expense, so the group's id is the one it finds the thing by.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-ledger-to-settlements-')), 'tally.sqlite');
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

describe('Ledger → Settlements', () => {
  it('reads the balances an expense made in Ledger gives, by the group id, and suggests the transfer that settles it', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }

    // Ada pays 300 for the three of them: she is owed 200, and Grace and Linus each owe 100.
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Groceries',
        amount: 300,
        date: '2026-03-01',
        splitBetween: [ada.id, grace.id, linus.id],
      },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const { id: expenseId } = recorded.body as { id: string };

    // Ledger holds the expense under the id its request answered.
    const expense = await http.request('GET', `${api}/expenses/${expenseId}`, { token: grace.token });
    expect(expense.status).toBe(200);

    const answer = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: grace.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { from: grace.id, to: ada.id, amount: 100 },
      { from: linus.id, to: ada.id, amount: 100 },
    ]);
  });
});
