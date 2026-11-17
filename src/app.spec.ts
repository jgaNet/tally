import { createApplication } from './app';
import { testDirectory } from './test-helpers';

describe('the application', () => {
  it('starts, answers under its prefix, and stops', async () => {
    const directory = testDirectory();
    const app = await createApplication({ databasePath: directory.databasePath });
    await app.start(0);
    const response = await fetch(`${app.address}/${app.apiPrefix}/nothing-here`);
    expect(response.status).toBe(404);
    await app.stop();
    directory.remove();
  });
});
