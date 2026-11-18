import { randomUUID } from 'node:crypto';

// Every database the tests make is named for the run that made it, so the run can drop them when it ends.
export default function globalSetup(): void {
  process.env.TALLY_TEST_RUN = randomUUID().replaceAll('-', '').slice(0, 12);
}
