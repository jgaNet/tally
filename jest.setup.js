import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Every test file gets a PostgreSQL database of its own, made on the server DATABASE_URL names, so no suite reads what
// another wrote. It is dropped when the file's process exits (best effort: the connections are closed by force).
const url = new URL(process.env.DATABASE_URL);
const admin = new URL(url);
admin.pathname = '/postgres';
const name = `tally_test_${randomUUID().replaceAll('-', '')}`;
execFileSync('psql', [admin.toString(), '-q', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${name}"`], {
  stdio: 'pipe',
});
url.pathname = `/${name}`;
process.env.DATABASE_URL = url.toString();
// A SQLite file is moved only when DATABASE_PATH names one that exists: no test has one.
delete process.env.DATABASE_PATH;
process.on('exit', () => {
  try {
    execFileSync('psql', [admin.toString(), '-q', '-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], {
      stdio: 'pipe',
    });
  } catch {
    // The server may be gone already: nothing to drop then.
  }
});
