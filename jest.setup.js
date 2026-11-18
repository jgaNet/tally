import { randomBytes } from 'node:crypto';

process.env.DATABASE_SCHEMA ||= `suite_${randomBytes(8).toString('hex')}`;
