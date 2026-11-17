import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test file gets a database of its own, in the temporary directory, so no suite reads what another wrote.
process.env.DATABASE_PATH = join(tmpdir(), `tally-test-${randomUUID()}.db`);
