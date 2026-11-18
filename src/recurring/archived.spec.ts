import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

/** The `day` of the month `months` from the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(months: number, day: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day));
  return month.toISOString().slice(0, 10);
}

describe('the background job and an archived group', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** A group of Ada's with Grace in it, and a recurring expense of 300 Ada pays, split between them, due on `startsOn`. */
  async function groupWithRecurring(
    ada: { id: string; token: string },
    grace: { id: string; token: string },
    name: string,
    startsOn: string,
  ): Promise<string> {
    const created = await send(app, 'POST', '/groups', { token: ada.token, payload: { name, currency: 'EUR' } });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    const recurring = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: {
        description: 'Rent share',
        amount: 30000,
        startsOn,
        category: 'rent',
        splitBetween: [ada.id, grace.id],
      },
    });
    expect(recurring.statusCode).toBe(201);
    return groupId;
  }

  async function expenseCount(token: string, groupId: string): Promise<number> {
    const response = await send(app, 'GET', `/groups/${groupId}/expenses`, { token });
    return response.json<unknown[]>().length;
  }

  it('records no expense of a recurring expense in an archived group, and still records one in a group not archived', async () => {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const startsOn = dayOfMonth(1, 5);
    const archivedGroup = await groupWithRecurring(ada, grace, 'Archived flat', startsOn);
    const openGroup = await groupWithRecurring(ada, grace, 'Open flat', startsOn);

    // Nothing was paid, so every balance is 0 and the group may be archived.
    const archived = await send(app, 'POST', `/groups/${archivedGroup}/archive`, { token: ada.token });
    expect(archived.statusCode).toBe(204);

    // The day has come for both: the job records the open group's expense, and none for the archived one.
    await app.runJobs(new Date(`${startsOn}T10:00:00Z`));
    expect(await expenseCount(ada.token, archivedGroup)).toBe(0);
    expect(await expenseCount(ada.token, openGroup)).toBe(1);
  });
});
