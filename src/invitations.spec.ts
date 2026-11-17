import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };

describe('invitations', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.path);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
  });

  afterEach(async () => {
    await app.stop();
    database.remove();
  });

  async function createGroup(name = 'The flat', token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', '/groups', { body: { name, currency: 'EUR' }, token });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const invite = (groupId: string, token = adaToken) => call(app, 'POST', `/groups/${groupId}/invitations`, { token });

  /** Creates an invitation and answers its id. */
  async function invitationTo(groupId: string, token = adaToken): Promise<string> {
    const answer = await invite(groupId, token);
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const accept = (invitationId: string, token: string) =>
    call(app, 'POST', `/invitations/${invitationId}/accept`, { token });

  describe('creating an invitation', () => {
    it('answers the id of the new invitation to a member of the group', async () => {
      const groupId = await createGroup();
      const answer = await invite(groupId);
      expect(answer.status).toBe(201);
      expect(typeof answer.body.id).toBe('string');
    });

    it('answers an id that is long and impossible to guess, and a different one each time', async () => {
      const groupId = await createGroup();
      const first = await invitationTo(groupId);
      const second = await invitationTo(groupId);
      expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(second).not.toBe(first);
    });

    it('refuses a group the account is not a member of, as if the group did not exist', async () => {
      const groupId = await createGroup();
      const notMember = await invite(groupId, graceToken);
      const missing = await invite('no-such-group', graceToken);
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      const groupId = await createGroup();
      expect((await call(app, 'POST', `/groups/${groupId}/invitations`)).status).toBe(401);
      expect((await invite(groupId, 'made-up-token')).status).toBe(401);
    });
  });

  describe('reading an invitation', () => {
    it('answers the group, its name and who invited, to a person who is not a member', async () => {
      const groupId = await createGroup('Lisbon trip');
      const id = await invitationTo(groupId);
      expect(await call(app, 'GET', `/invitations/${id}`, { token: graceToken })).toEqual({
        status: 200,
        body: { id, groupId, groupName: 'Lisbon trip', invitedBy: adaId },
      });
    });

    it('names the member who created the invitation, not the owner', async () => {
      const groupId = await createGroup();
      const id = await invitationTo(groupId, adaToken);
      await accept(await invitationTo(groupId), graceToken);
      const graceInvitation = await invitationTo(groupId, graceToken);
      expect((await call(app, 'GET', `/invitations/${graceInvitation}`, { token: linusToken })).body.invitedBy).toBe(
        graceId,
      );
      expect((await call(app, 'GET', `/invitations/${id}`, { token: linusToken })).body.invitedBy).toBe(adaId);
    });

    it('does not make the reader a member of the group', async () => {
      const groupId = await createGroup();
      const id = await invitationTo(groupId);
      expect((await call(app, 'GET', `/invitations/${id}`, { token: graceToken })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}`, { token: graceToken })).status).toBe(404);
    });

    it('answers 404 for an invitation that does not exist', async () => {
      expect((await call(app, 'GET', '/invitations/no-such-invitation', { token: graceToken })).status).toBe(404);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      const id = await invitationTo(await createGroup());
      expect((await call(app, 'GET', `/invitations/${id}`)).status).toBe(401);
      expect((await call(app, 'GET', `/invitations/${id}`, { token: 'made-up-token' })).status).toBe(401);
    });
  });

  describe('joining a group', () => {
    it('makes the account a member, who then sees the group and lists it among its groups', async () => {
      const groupId = await createGroup('The flat');
      const id = await invitationTo(groupId);
      expect((await accept(id, graceToken)).status).toBe(204);
      expect((await call(app, 'GET', `/groups/${groupId}`, { token: graceToken })).body).toEqual({
        id: groupId,
        name: 'The flat',
        currency: 'EUR',
        ownerId: adaId,
      });
      const mine = await call(app, 'GET', '/groups/mine', { token: graceToken });
      expect(mine.body.map((g: { id: string }) => g.id)).toEqual([groupId]);
    });

    it('lets any number of people join by one invitation, which stays usable', async () => {
      const groupId = await createGroup();
      const id = await invitationTo(groupId);
      expect((await accept(id, graceToken)).status).toBe(204);
      expect((await accept(id, linusToken)).status).toBe(204);
      expect((await call(app, 'GET', `/invitations/${id}`, { token: linusToken })).status).toBe(200);
      const members = await call(app, 'GET', `/groups/${groupId}/members`, { token: adaToken });
      expect(members.body.map((m: { memberId: string }) => m.memberId)).toEqual([adaId, graceId, linusId]);
    });

    it('refuses an account that is already a member, and leaves its membership as it was', async () => {
      const groupId = await createGroup();
      const id = await invitationTo(groupId);
      await accept(id, graceToken);
      const again = await accept(id, graceToken);
      expect(again).toEqual({ status: 409, body: { type: 'AlreadyMember', message: expect.any(String) } });
      const members = await call(app, 'GET', `/groups/${groupId}/members`, { token: adaToken });
      expect(members.body.map((m: { memberId: string }) => m.memberId)).toEqual([adaId, graceId]);
    });

    it('refuses the owner accepting an invitation to their own group', async () => {
      const groupId = await createGroup();
      const answer = await accept(await invitationTo(groupId), adaToken);
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('AlreadyMember');
    });

    it('answers 404 for an invitation that does not exist', async () => {
      expect((await accept('no-such-invitation', graceToken)).status).toBe(404);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      const id = await invitationTo(await createGroup());
      expect((await call(app, 'POST', `/invitations/${id}/accept`)).status).toBe(401);
      expect((await accept(id, 'made-up-token')).status).toBe(401);
    });
  });
});
