import { createApplication } from './app';
import { ensureDatabase, testDirectory } from './test-helpers';

describe('the application', () => {
  it('starts, answers under its prefix, and stops', async () => {
    const directory = testDirectory();
    await ensureDatabase(directory.databaseUrl);
    const app = await createApplication({ databaseUrl: directory.databaseUrl });
    await app.start(0);
    const response = await fetch(`${app.address}/${app.apiPrefix}/nothing-here`);
    expect(response.status).toBe(404);
    await app.stop();
    await directory.remove();
  });
});
