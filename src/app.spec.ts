import { Application } from './app';
import { startApplication, temporaryDatabase } from './test-support';

describe('the application', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application | undefined;

  beforeEach(() => {
    database = temporaryDatabase();
  });

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    database.remove();
  });

  it('starts, answers under its prefix, and stops', async () => {
    app = await startApplication(database.path);
    const response = await fetch(`${app.address}/${app.apiPrefix}/nothing-here`);
    expect(response.status).toBe(404);
  });

  it('answers a body that is not JSON with 400, and a wrong-typed field with 400', async () => {
    app = await startApplication(database.path);
    const malformed = await fetch(`${app.address}/${app.apiPrefix}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(malformed.status).toBe(400);
    const wrongType = await fetch(`${app.address}/${app.apiPrefix}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: 12345678, name: 'Ada' }),
    });
    expect(wrongType.status).toBe(400);
  });
});
