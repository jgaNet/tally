import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const JOINED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('members', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  async function createGroup(name = 'The flat', token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', '/groups', { body: { name, currency: 'EUR' }, token });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  async function join(groupId: string, token: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token })).status).toBe(204);
  }

  const members = (groupId: string, token = adaToken) => call(app, 'GET', `/groups/${groupId}/members`, { token });

  describe('listing the members', () => {
    it('lists the owner first, with the role owner, and then the others in the order they joined', async () => {
      const groupId = await createGroup();
      await join(groupId, graceToken);
      await join(groupId, linusToken);
      const answer = await members(groupId);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual([
        { memberId: adaId, name: 'Ada Lovelace', role: 'owner', joinedAt: expect.stringMatching(JOINED_AT) },
        { memberId: graceId, name: 'Grace Hopper', role: 'member', joinedAt: expect.stringMatching(JOINED_AT) },
        { memberId: linusId, name: 'Linus Torvalds', role: 'member', joinedAt: expect.stringMatching(JOINED_AT) },
      ]);
    });

    it('lists the owner alone in a group nobody has joined', async () => {
      const groupId = await createGroup();
      expect((await members(groupId)).body.map((m: { memberId: string }) => m.memberId)).toEqual([adaId]);
    });

    it('answers the join times in order, the earliest first', async () => {
      const groupId = await createGroup();
      await join(groupId, graceToken);
      await join(groupId, linusToken);
      const times = (await members(groupId)).body.map((m: { joinedAt: string }) => Date.parse(m.joinedAt));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('lets a member see the members, and a member who joined see them too', async () => {
      const groupId = await createGroup();
      await join(groupId, graceToken);
      expect((await members(groupId, graceToken)).body).toHaveLength(2);
    });

    it('answers 404 to an account that is not a member, as if the group did not exist', async () => {
      const groupId = await createGroup();
      const notMember = await members(groupId, linusToken);
      const missing = await members('no-such-group', linusToken);
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      const groupId = await createGroup();
      expect((await call(app, 'GET', `/groups/${groupId}/members`)).status).toBe(401);
      expect((await members(groupId, 'made-up-token')).status).toBe(401);
    });
  });

  describe('my groups, with the groups joined', () => {
    it('lists a joined group among the groups of the account, in its place by creation', async () => {
      const first = await createGroup('First');
      const graceGroup = await createGroup('Grace own', graceToken);
      const third = await createGroup('Third');
      // Grace joins the third, then the first: the order of my groups is by creation, not by joining.
      await join(third, graceToken);
      await join(first, graceToken);
      const answer = await call(app, 'GET', '/groups/mine', { token: graceToken });
      expect(answer.body.map((g: { id: string }) => g.id)).toEqual([third, graceGroup, first]);
    });

    it('does not list a group the account has not joined', async () => {
      await createGroup('Ada only');
      const answer = await call(app, 'GET', '/groups/mine', { token: graceToken });
      expect(answer.body).toEqual([]);
    });
  });
});
