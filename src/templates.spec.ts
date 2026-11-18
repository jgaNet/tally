import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const eve = { email: 'eve@example.com', password: 'outsider-2026', name: 'Eve Outsider' };

const today = (): string => new Date().toISOString().slice(0, 10);

/** A template as the API answers it, with the split it was given. */
interface Template {
  id: string;
  groupId: string;
  name: string;
  splitBetween?: string[];
  splitByShares?: { memberId: string; shares: number }[];
}

describe('split templates', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let eveId: string;
  let eveToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Saves a template of the group, as the body gives it. */
  async function save(body: Record<string, unknown>, token = adaToken, group = groupId) {
    return call(app, 'POST', `/groups/${group}/templates`, { body, token });
  }

  /** Saves an equal template of the group under the name, between the three members. */
  async function saveEqual(name: string, members: string[] = [adaId, graceId, linusId], token = adaToken) {
    const answer = await save({ name, splitBetween: members }, token);
    expect(answer.status).toBe(201);
    return answer.body.id as string;
  }

  async function templatesOf(token = adaToken): Promise<Template[]> {
    const answer = await call(app, 'GET', `/groups/${groupId}/templates`, { token });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  /** Records an expense of the group, paid by the token's account, dated today, with the body's fields. */
  async function record(fields: Record<string, unknown>, token = adaToken) {
    return call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Shop', amount: 9000, date: today(), ...fields },
      token,
    });
  }

  async function expenseOf(id: string) {
    const answer = await call(app, 'GET', `/expenses/${id}`, { token: adaToken });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ id: eveId, token: eveToken } = await accountOf(eve));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  describe('saving a template', () => {
    it('saves an equal template under its name, and answers its id', async () => {
      const answer = await save({ name: 'Flat', splitBetween: [adaId, graceId] });
      expect(answer.status).toBe(201);
      expect(answer.body).toEqual({ id: expect.any(String) });
      expect(await templatesOf()).toEqual([
        { id: answer.body.id, groupId, name: 'Flat', splitBetween: [adaId, graceId] },
      ]);
    });

    it('saves a template by shares, and reads its shares as they were given', async () => {
      const answer = await save({
        name: 'Big room',
        splitByShares: [
          { memberId: adaId, shares: 2 },
          { memberId: graceId, shares: 1 },
        ],
      });
      expect(answer.status).toBe(201);
      expect(await templatesOf()).toEqual([
        {
          id: answer.body.id,
          groupId,
          name: 'Big room',
          splitByShares: [
            { memberId: adaId, shares: 2 },
            { memberId: graceId, shares: 1 },
          ],
        },
      ]);
    });

    it('lists the templates the earliest saved first, to any member', async () => {
      const first = await saveEqual('Second');
      const second = await saveEqual('Third', [adaId, linusId]);
      const listed = await templatesOf(graceToken);
      expect(listed.map(template => template.id)).toEqual([first, second]);
      expect(listed.map(template => template.name)).toEqual(['Second', 'Third']);
    });

    it('keeps the name trimmed', async () => {
      await saveEqual('  Rent  ');
      expect((await templatesOf())[0].name).toBe('Rent');
    });

    it('accepts a name of 1 character and of 60, and refuses one that is only spaces or of 61, with 422', async () => {
      expect((await save({ name: 'x', splitBetween: [adaId] })).status).toBe(201);
      expect((await save({ name: 'y'.repeat(60), splitBetween: [adaId] })).status).toBe(201);
      for (const name of ['   ', '', 'z'.repeat(61)]) {
        const answer = await save({ name, splitBetween: [adaId] });
        expect(answer.status).toBe(422);
        expect(answer.body.type).toBe('InvalidName');
      }
      expect(await templatesOf()).toHaveLength(2);
    });

    it('refuses a name that another template of the group has, in any case, with 409', async () => {
      await saveEqual('Weekly shop');
      const answer = await save({ name: ' WEEKLY SHOP ', splitBetween: [adaId] });
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('TemplateNameTaken');
      expect(await templatesOf()).toHaveLength(1);
    });

    it('allows the same name in another group', async () => {
      await saveEqual('Weekly shop');
      const other = (await call(app, 'POST', '/groups', { body: { name: 'Other', currency: 'USD' }, token: adaToken }))
        .body.id;
      expect((await save({ name: 'Weekly shop', splitBetween: [adaId] }, adaToken, other)).status).toBe(201);
    });

    it('refuses a split that names no one, a member twice, or a stranger, with 422', async () => {
      const strangers = [
        { splitBetween: [] },
        { splitBetween: [adaId, adaId] },
        { splitBetween: [adaId, eveId] },
        {
          splitByShares: [
            { memberId: adaId, shares: 1 },
            { memberId: adaId, shares: 2 },
          ],
        },
      ];
      for (const split of strangers) {
        const answer = await save({ name: 'Bad', ...split });
        expect(answer.status).toBe(422);
        expect(answer.body.type).toBe('InvalidSplit');
      }
      expect(await templatesOf()).toEqual([]);
    });

    it('refuses a member of a split by shares with no share, with 422', async () => {
      const answer = await save({
        name: 'Nothing',
        splitByShares: [
          { memberId: adaId, shares: 1 },
          { memberId: graceId, shares: 0 },
        ],
      });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidSplit');
    });

    it('refuses a template with neither split, or with both, as of the wrong shape, with 400', async () => {
      expect((await save({ name: 'Neither' })).status).toBe(400);
      expect(
        (await save({ name: 'Both', splitBetween: [adaId], splitByShares: [{ memberId: adaId, shares: 1 }] })).status,
      ).toBe(400);
      expect(await templatesOf()).toEqual([]);
    });

    it('refuses a name left out, with 400', async () => {
      expect((await save({ splitBetween: [adaId] })).status).toBe(400);
    });

    it('answers an account that is not a member of the group with 404, to save a template or to read them', async () => {
      expect((await save({ name: 'Mine', splitBetween: [adaId] }, eveToken)).status).toBe(404);
      expect((await call(app, 'GET', `/groups/${groupId}/templates`, { token: eveToken })).status).toBe(404);
    });
  });

  describe('splitting an expense by a template', () => {
    it('splits an expense as if the equal template split had been given, with the remainder to the first member', async () => {
      const template = await saveEqual('Flat');
      const answer = await record({ amount: 10001, template });
      expect(answer.status).toBe(201);
      const expense = await expenseOf(answer.body.id);
      expect(expense.splitKind).toBe('equal');
      expect(expense.shares).toEqual([
        { memberId: adaId, amount: 3335 },
        { memberId: graceId, amount: 3333 },
        { memberId: linusId, amount: 3333 },
      ]);
    });

    it('splits an expense as if the template by shares had been given, and says it was split by shares', async () => {
      const template = (
        await save({
          name: 'Big room',
          splitByShares: [
            { memberId: adaId, shares: 2 },
            { memberId: graceId, shares: 1 },
          ],
        })
      ).body.id;
      const expense = await expenseOf((await record({ template })).body.id);
      expect(expense.splitKind).toBe('shares');
      expect(expense.shares).toEqual([
        { memberId: adaId, amount: 6000 },
        { memberId: graceId, amount: 3000 },
      ]);
    });

    it('refuses an expense with a template and another split, or with none, with 400', async () => {
      const template = await saveEqual('Flat');
      expect((await record({ template, splitBetween: [adaId, graceId] })).status).toBe(400);
      expect((await record({ template, splitExactly: [{ memberId: adaId, amount: 9000 }] })).status).toBe(400);
      expect((await record({ template, splitByShares: [{ memberId: adaId, shares: 1 }] })).status).toBe(400);
      expect((await record({})).status).toBe(400);
    });

    it('refuses a template of another group, or one that does not exist, with 404', async () => {
      const otherGroup = (
        await call(app, 'POST', '/groups', { body: { name: 'Elsewhere', currency: 'EUR' }, token: eveToken })
      ).body.id;
      const elsewhere = (await save({ name: 'Elsewhere', splitBetween: [eveId] }, eveToken, otherGroup)).body.id;
      expect((await record({ template: elsewhere })).status).toBe(404);
      expect((await record({ template: 'no-such-template' })).status).toBe(404);
    });

    it('refuses an expense whose payer is not among the members of the template, with 422', async () => {
      const template = await saveEqual('Without the payer', [graceId, linusId]);
      const answer = await record({ template });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidSplit');
    });

    it('refuses an expense whose template names a member who has left the group, with 422', async () => {
      const template = await saveEqual('Flat');
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
      const answer = await record({ template });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidSplit');
    });

    it('splits an edited expense by a template, from the version it was read at', async () => {
      const id = (await record({ splitBetween: [adaId, graceId, linusId] })).body.id;
      const template = await saveEqual('Two of us', [adaId, graceId]);
      const edit = await call(app, 'PUT', `/expenses/${id}`, {
        body: { description: 'Shop', amount: 9000, date: today(), version: 1, template },
        token: adaToken,
      });
      expect(edit.status).toBe(204);
      const expense = await expenseOf(id);
      expect(expense.version).toBe(2);
      expect(expense.splitKind).toBe('equal');
      expect(expense.shares).toEqual([
        { memberId: adaId, amount: 4500 },
        { memberId: graceId, amount: 4500 },
      ]);

      const stale = await call(app, 'PUT', `/expenses/${id}`, {
        body: { description: 'Shop', amount: 9000, date: today(), version: 1, template },
        token: adaToken,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.type).toBe('ExpenseChanged');
    });

    it('refuses an edit that gives a template with another split, with 400', async () => {
      const id = (await record({ splitBetween: [adaId, graceId] })).body.id;
      const template = await saveEqual('Flat');
      const edit = await call(app, 'PUT', `/expenses/${id}`, {
        body: {
          description: 'Shop',
          amount: 9000,
          date: today(),
          version: 1,
          template,
          splitBetween: [adaId, graceId],
        },
        token: adaToken,
      });
      expect(edit.status).toBe(400);
    });

    it('keeps the shares of an expense when its template is changed or removed later', async () => {
      const template = await saveEqual('Flat');
      const id = (await record({ template })).body.id;
      const before = await expenseOf(id);

      const replaced = await call(app, 'PUT', `/templates/${template}`, {
        body: { name: 'Flat', splitBetween: [adaId, linusId] },
        token: adaToken,
      });
      expect(replaced.status).toBe(204);
      expect(await expenseOf(id)).toEqual(before);

      const removed = await call(app, 'DELETE', `/templates/${template}`, { token: adaToken });
      expect(removed.status).toBe(204);
      expect(await expenseOf(id)).toEqual(before);
    });
  });

  describe('changing a template', () => {
    it('lets the member who saved it replace it under the same rules, keeping its place in the order', async () => {
      const first = await saveEqual('First', [adaId, graceId], graceToken);
      const second = await saveEqual('Second');
      const replaced = await call(app, 'PUT', `/templates/${first}`, {
        body: {
          name: 'First, again',
          splitByShares: [
            { memberId: graceId, shares: 3 },
            { memberId: linusId, shares: 1 },
          ],
        },
        token: graceToken,
      });
      expect(replaced.status).toBe(204);
      expect(await templatesOf()).toEqual([
        {
          id: first,
          groupId,
          name: 'First, again',
          splitByShares: [
            { memberId: graceId, shares: 3 },
            { memberId: linusId, shares: 1 },
          ],
        },
        { id: second, groupId, name: 'Second', splitBetween: [adaId, graceId, linusId] },
      ]);
    });

    it('refuses a replacement under the rules of a template, and leaves the template as it was', async () => {
      const id = await saveEqual('Flat');
      const answer = await call(app, 'PUT', `/templates/${id}`, {
        body: { name: 'Flat', splitBetween: [adaId, eveId] },
        token: adaToken,
      });
      expect(answer.status).toBe(422);
      expect((await templatesOf())[0].splitBetween).toEqual([adaId, graceId, linusId]);
    });

    it('lets the owner replace a template another member saved', async () => {
      const id = await saveEqual('Graces', [graceId, linusId], graceToken);
      const answer = await call(app, 'PUT', `/templates/${id}`, {
        body: { name: 'Graces', splitBetween: [graceId] },
        token: adaToken,
      });
      expect(answer.status).toBe(204);
      expect((await templatesOf())[0].splitBetween).toEqual([graceId]);
    });

    it('refuses any other member who replaces or removes a template, with 403, and changes nothing', async () => {
      const id = await saveEqual('Flat');
      const replaced = await call(app, 'PUT', `/templates/${id}`, {
        body: { name: 'Taken', splitBetween: [linusId] },
        token: linusToken,
      });
      expect(replaced.status).toBe(403);
      expect(replaced.body.type).toBe('NotAllowed');

      const removed = await call(app, 'DELETE', `/templates/${id}`, { token: linusToken });
      expect(removed.status).toBe(403);
      expect(removed.body.type).toBe('NotAllowed');

      expect(await templatesOf()).toEqual([{ id, groupId, name: 'Flat', splitBetween: [adaId, graceId, linusId] }]);
    });

    it('answers a template to a stranger to the group as not found, to replace or remove it', async () => {
      const id = await saveEqual('Flat');
      const replaced = await call(app, 'PUT', `/templates/${id}`, {
        body: { name: 'Mine', splitBetween: [adaId] },
        token: eveToken,
      });
      expect(replaced.status).toBe(404);
      expect((await call(app, 'DELETE', `/templates/${id}`, { token: eveToken })).status).toBe(404);
    });

    it('refuses a replacement with the name of another template of the group, with 409, and keeps its own name', async () => {
      const id = await saveEqual('Flat');
      await saveEqual('Rent');
      const taken = await call(app, 'PUT', `/templates/${id}`, {
        body: { name: 'rent', splitBetween: [adaId] },
        token: adaToken,
      });
      expect(taken.status).toBe(409);
      expect(taken.body.type).toBe('TemplateNameTaken');

      const kept = await call(app, 'PUT', `/templates/${id}`, {
        body: { name: 'FLAT', splitBetween: [adaId] },
        token: adaToken,
      });
      expect(kept.status).toBe(204);
      expect((await templatesOf())[0].name).toBe('FLAT');
    });

    it('refuses a replacement of the wrong shape, with 400', async () => {
      const id = await saveEqual('Flat');
      const answer = await call(app, 'PUT', `/templates/${id}`, { body: { name: 'Flat' }, token: adaToken });
      expect(answer.status).toBe(400);
    });

    it('removes a template by its saver, and any template by the owner, and it is no longer listed', async () => {
      const mine = await saveEqual('Mine', [graceId], graceToken);
      const theirs = await saveEqual('Theirs', [linusId], linusToken);
      expect((await call(app, 'DELETE', `/templates/${mine}`, { token: graceToken })).status).toBe(204);
      expect((await call(app, 'DELETE', `/templates/${theirs}`, { token: adaToken })).status).toBe(204);
      expect(await templatesOf()).toEqual([]);
      expect((await call(app, 'DELETE', `/templates/${mine}`, { token: graceToken })).status).toBe(404);
    });
  });
});
