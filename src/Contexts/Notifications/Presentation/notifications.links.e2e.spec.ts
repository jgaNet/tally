import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationship ADR 13 declares, over HTTP: Ledger records an expense, and Notifications makes a notice for each member of its split
 * but the payer from the ExpenseRecorded fact. The expense is made through the API, its id is the one that request answered, and the
 * notice is found by that same id, for the member it concerns and with their share. Each relationship of the context map is named by its
 * title, so that the gate can see the test that holds it.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-notification-links-'));
  // The background sweep runs often and a week is a fraction of a second, so the debts of this file are reminded or not within the test.
  app = await createApplication({
    databasePath: join(directory, 'tally.sqlite'),
    logger: silent,
    jobsIntervalSeconds: 0.05,
    reminderPeriodSeconds: 0.3,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

describe('Ledger → Notifications (ExpenseRecorded)', () => {
  it('a notice for an expense Ledger recorded is found by the id that recording answered, for the member it concerns, with their share', async () => {
    const ann = await person('Ann', 'ann@links.example.com');
    const bob = await person('Bob', 'bob@links.example.com');
    const cy = await person('Cy', 'cy@links.example.com');

    const { body: group } = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Links', currency: 'EUR' },
    });
    const groupId = (group as { id: string }).id;
    for (const who of [bob, cy]) {
      const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
      await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: who.token,
      });
    }

    // Ann pays, and the expense is split between Ann, Bob and Cy: each of Bob and Cy owes a third.
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 1200, date: '2020-01-10', splitBetween: [ann.id, bob.id, cy.id] },
    });
    const expenseId = (recorded.body as { id: string }).id;

    let found: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 120 && !found; poll++) {
      const { body } = await http.request('GET', `${api}/notices`, { token: cy.token });
      found = (body as Array<Record<string, unknown>>).find(notice => notice.expenseId === expenseId);
      if (!found) await new Promise(resolve => setTimeout(resolve, 25));
    }

    expect(found).toEqual({
      id: expect.any(String),
      kind: 'expense',
      groupId,
      expenseId,
      amount: 400,
      at: expect.any(String),
    });
    // Bob, the other member of the split, has his own notice of it, once; Ann, who paid, has none.
    const { body: bobsNotices } = await http.request('GET', `${api}/notices`, { token: bob.token });
    expect(
      (bobsNotices as Array<Record<string, unknown>>).filter(notice => notice.expenseId === expenseId),
    ).toHaveLength(1);
  });
});

describe('Settlements → Notifications (OutstandingDebts)', () => {
  it('the sweep reads what each member still owes with the settlements counted: a member who has paid down to 2000 is never reminded, one who has not is', async () => {
    const ann = await person('Ann', 'ann@debts.example.com');
    const bob = await person('Bob', 'bob@debts.example.com');
    const cy = await person('Cy', 'cy@debts.example.com');

    const { body: group } = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Debts', currency: 'EUR' },
    });
    const groupId = (group as { id: string }).id;
    for (const who of [bob, cy]) {
      const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
      await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: who.token,
      });
    }

    // Ann pays 9000 for three: Bob and Cy each owe 3000. Ann, the payee, is paid 2000 in cash by Bob, so Bob owes 1000 at the sweep.
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Trip', amount: 9000, date: '2020-01-10', splitBetween: [ann.id, bob.id, cy.id] },
    });
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 2000 },
    });
    expect(paid.status).toBe(201);

    // Cy is reminded, for what Cy still owes, and Bob never is.
    let cyReminder: Record<string, unknown> | undefined;
    for (let poll = 0; poll < 200 && !cyReminder; poll++) {
      const { body } = await http.request('GET', `${api}/notices`, { token: cy.token });
      cyReminder = (body as Array<Record<string, unknown>>).find(notice => notice.kind === 'reminder');
      if (!cyReminder) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(cyReminder).toMatchObject({ kind: 'reminder', groupId, amount: 3000 });

    await new Promise(resolve => setTimeout(resolve, 400));
    const { body: bobsNotices } = await http.request('GET', `${api}/notices`, { token: bob.token });
    expect((bobsNotices as Array<Record<string, unknown>>).filter(notice => notice.kind === 'reminder')).toEqual([]);
  });
});
