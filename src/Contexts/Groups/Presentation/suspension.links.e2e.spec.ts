import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationships request 34 carries, over HTTP (feature 34, ADR 29): a suspended account is refused in Ledger and in Settlements by the
 * group it is a member of, which Groups made and answered by its id, and by the account's suspension Groups keeps. Each relationship of the
 * context map is named by its title, so that the gate can see the test that holds it.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let admin: { token: string; id: string };

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';
const ADMIN_EMAIL = 'links-admin@example.com';
let counter = 0;

beforeAll(async () => {
  app = await createApplication({
    databaseUrl: await freshDatabase(),
    logger: silent,
    administratorEmails: [ADMIN_EMAIL],
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  admin = await person(ADMIN_EMAIL);
});
afterAll(async () => {
  await app.stop();
});

/** A signed-in person, with the id the account answers; a new one each time. */
async function person(email = `links${++counter}@example.com`) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name: 'Person' } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group Ann made in Groups, Bob joined, and Ann paid 1000 for both: the id the creation answered, and the two members. */
async function groupMadeInGroups() {
  const ann = await person();
  const bob = await person();
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  return { groupId, ann, bob };
}

describe('Groups → Ledger (GroupMembers)', () => {
  it('a suspended member is refused an expense in the group Groups made, found by the id its creation answered, and the others record in it', async () => {
    const { groupId, ann, bob } = await groupMadeInGroups();
    expect(
      (await http.request('PUT', `${api}/admin/accounts/${bob.id}/suspension`, { token: admin.token })).status,
    ).toBe(204);

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: bob.token,
      body: { description: 'Coffee', amount: 300, date: PAST_DAY, splitBetween: [bob.id] },
    });
    expect(refused).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    expect(recorded.status).toBeLessThan(300);
    const expense = await http.request('GET', `${api}/expenses/${(recorded.body as { id: string }).id}`, {
      token: ann.token,
    });
    expect(expense.body).toMatchObject({ groupId });
  });
});

describe('Groups → Settlements (SettlementMembers)', () => {
  it('a suspended payee is refused a cash settlement in the group Groups made, and is found by the id its creation answered', async () => {
    const { groupId, ann, bob } = await groupMadeInGroups();
    // Bob paid for both, so Ann owes him 500: Bob is the payee of what Ann settles.
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: bob.token,
      body: { description: 'Dinner', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    await http.request('PUT', `${api}/admin/accounts/${bob.id}/suspension`, { token: admin.token });

    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: ann.id, amount: 500 },
    });
    expect(refused).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });

    await http.request('DELETE', `${api}/admin/accounts/${bob.id}/suspension`, { token: admin.token });
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: ann.id, amount: 500 },
    });
    expect(paid.status).toBeLessThan(300);
    const settlements = (await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: ann.token }))
      .body as {
      groupId: string;
    }[];
    expect(settlements.map(settlement => settlement.groupId)).toEqual([groupId]);
  });
});
