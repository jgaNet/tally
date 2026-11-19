import { type Application, createApplication } from '../app';
import { send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

describe('the administrators the server is started with', () => {
  const started = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (started === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = started;
    }
  });

  it('are the emails of ADMIN_EMAILS, when the application is made without a list of its own', async () => {
    process.env.ADMIN_EMAILS = 'Boss@Example.com, ops@example.com';
    let app: Application | undefined;
    try {
      app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
      const boss = await signedUpAccount(app, { email: 'boss@example.com', name: 'Boss' });
      const ada = await signedUpAccount(app, { email: 'ada@example.com', name: 'Ada' });
      expect((await send(app, 'GET', '/admin/contests', { token: boss.token })).statusCode).toBe(200);
      expect((await send(app, 'GET', '/admin/contests', { token: ada.token })).statusCode).toBe(404);
    } finally {
      await app?.stop();
    }
  });
});
