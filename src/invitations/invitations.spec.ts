import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe('invitations', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function createdGroup(token: string, name = 'Flat 4B'): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name, currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function invite(token: string, groupId: string) {
    return send(app, 'POST', `/groups/${groupId}/invitations`, { token });
  }

  describe('creating an invitation', () => {
    it('creates one for a member and answers its id', async () => {
      const { token } = await signedUpAccount(app);
      const groupId = await createdGroup(token);
      const response = await invite(token, groupId);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: expect.any(String) });
    });

    it('gives an id long and hard to guess, and a different one each time', async () => {
      const { token } = await signedUpAccount(app);
      const groupId = await createdGroup(token);
      const first = (await invite(token, groupId)).json().id;
      const second = (await invite(token, groupId)).json().id;
      expect(first.length).toBeGreaterThanOrEqual(40);
      expect(first).not.toBe(second);
    });

    it('lets any member invite, not only the owner', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
      const groupId = await createdGroup(ada.token);
      await joinThroughInvitation(app, ada.token, grace.token, groupId);

      const response = await invite(grace.token, groupId);
      expect(response.statusCode).toBe(201);
      const invitation = (await send(app, 'GET', `/invitations/${response.json().id}`, { token: linus.token })).json();
      expect(invitation.invitedBy).toBe(grace.id);
    });

    it('answers 404 to a signed-in person who is not a member, as if the group did not exist', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token);

      const outsider = await invite(grace.token, groupId);
      const missing = await invite(grace.token, 'no-such-group');
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json().type).toBe('NotFound');
      expect(outsider.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { token } = await signedUpAccount(app);
      const groupId = await createdGroup(token);
      expect((await send(app, 'POST', `/groups/${groupId}/invitations`)).statusCode).toBe(401);
      expect((await invite('not-a-real-token', groupId)).statusCode).toBe(401);
    });
  });

  describe('reading an invitation', () => {
    it('answers the group, its name, and who invited, to a signed-in person who is not a member', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token, 'Lisbon');
      const id = (await invite(ada.token, groupId)).json().id;

      const response = await send(app, 'GET', `/invitations/${id}`, { token: grace.token });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id, groupId, groupName: 'Lisbon', invitedBy: ada.id });
    });

    it('answers the same invitation on every read', async () => {
      const { token } = await signedUpAccount(app);
      const groupId = await createdGroup(token);
      const id = (await invite(token, groupId)).json().id;
      const first = await send(app, 'GET', `/invitations/${id}`, { token });
      const second = await send(app, 'GET', `/invitations/${id}`, { token });
      expect(second.json()).toEqual(first.json());
    });

    it('does not make the reader a member: a read changes nothing', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token);
      const id = (await invite(ada.token, groupId)).json().id;

      await send(app, 'GET', `/invitations/${id}`, { token: grace.token });
      expect((await send(app, 'GET', '/groups/mine', { token: grace.token })).json()).toEqual([]);
      expect((await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).statusCode).toBe(404);
    });

    it('answers 404 for an invitation that does not exist', async () => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'GET', '/invitations/no-such-invitation', { token });
      expect(response.statusCode).toBe(404);
      expect(response.json().type).toBe('NotFound');
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { token } = await signedUpAccount(app);
      const groupId = await createdGroup(token);
      const id = (await invite(token, groupId)).json().id;
      expect((await send(app, 'GET', `/invitations/${id}`)).statusCode).toBe(401);
      expect((await send(app, 'GET', `/invitations/${id}`, { token: 'not-a-real-token' })).statusCode).toBe(401);
    });
  });

  describe('joining', () => {
    it('makes the caller a member, so the group is theirs to read and is among their groups', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token, 'Lisbon');
      const id = (await invite(ada.token, groupId)).json().id;

      const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: grace.token });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.json()).toEqual({ groupId });

      expect((await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).statusCode).toBe(200);
      const mine = await send(app, 'GET', '/groups/mine', { token: grace.token });
      expect(mine.json().map((g: { id: string }) => g.id)).toEqual([groupId]);
    });

    it('lets any number of people join by the same invitation, which stays usable', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
      const groupId = await createdGroup(ada.token);
      const id = (await invite(ada.token, groupId)).json().id;

      expect((await send(app, 'POST', `/invitations/${id}/accept`, { token: grace.token })).statusCode).toBe(201);
      expect((await send(app, 'POST', `/invitations/${id}/accept`, { token: linus.token })).statusCode).toBe(201);
      expect((await send(app, 'GET', `/invitations/${id}`, { token: linus.token })).statusCode).toBe(200);
      expect((await send(app, 'GET', '/groups/mine', { token: linus.token })).json()).toHaveLength(1);
    });

    it('refuses a second join of the same group with 409, and the owner joining their own group too', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token);
      const id = (await invite(ada.token, groupId)).json().id;
      await send(app, 'POST', `/invitations/${id}/accept`, { token: grace.token });

      const again = await send(app, 'POST', `/invitations/${id}/accept`, { token: grace.token });
      expect(again.statusCode).toBe(409);
      expect(again.json().type).toBe('AlreadyMember');

      const owner = await send(app, 'POST', `/invitations/${id}/accept`, { token: ada.token });
      expect(owner.statusCode).toBe(409);
      expect(owner.json().type).toBe('AlreadyMember');
    });

    it('keeps the group in its place among their groups, by when the group was made', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const first = await createdGroup(ada.token, 'First');
      await createdGroup(ada.token, 'Second');
      const third = await createdGroup(ada.token, 'Third');
      await joinThroughInvitation(app, ada.token, grace.token, third);
      await joinThroughInvitation(app, ada.token, grace.token, first);

      const mine = await send(app, 'GET', '/groups/mine', { token: grace.token });
      expect(mine.json().map((g: { id: string }) => g.id)).toEqual([third, first]);
    });

    it('answers 404 for an invitation that does not exist, and joins nothing', async () => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'POST', '/invitations/no-such-invitation/accept', { token });
      expect(response.statusCode).toBe(404);
      expect(response.json().type).toBe('NotFound');
      expect((await send(app, 'GET', '/groups/mine', { token })).json()).toEqual([]);
    });

    it('answers 401 to a request with no token, and joins nothing', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token);
      const id = (await invite(ada.token, groupId)).json().id;

      expect((await send(app, 'POST', `/invitations/${id}/accept`)).statusCode).toBe(401);
      expect((await send(app, 'POST', `/invitations/${id}/accept`, { token: 'not-a-real-token' })).statusCode).toBe(
        401,
      );
      expect((await send(app, 'GET', '/groups/mine', { token: grace.token })).json()).toEqual([]);
    });
  });

  describe('what is kept', () => {
    it('keeps invitations and memberships when the application stops and starts again on the same file', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token, 'Lisbon');
      const id = (await invite(ada.token, groupId)).json().id;
      await send(app, 'POST', `/invitations/${id}/accept`, { token: grace.token });
      await app.stop();

      app = await createApplication({ databasePath });
      expect((await send(app, 'GET', `/invitations/${id}`, { token: grace.token })).json().groupName).toBe('Lisbon');
      const members = await send(app, 'GET', `/groups/${groupId}/members`, { token: ada.token });
      expect(members.json().map((m: { memberId: string }) => m.memberId)).toEqual([ada.id, grace.id]);
    });
  });
});
