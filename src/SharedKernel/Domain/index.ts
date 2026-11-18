/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. Five things today, an Email, the Roles, the one rule an archived group refuses
 * a change by (GroupArchived, feature 27), the one rule a suspended account is refused by
 * (AccountSuspended, feature 34), the one rule a deleted account is refused by (AccountDeleted, feature 35)
 * and the currencies with their minor units (Currency, feature 40, ADR 32);
 * the published contracts between contexts are next door in Application/IntegrationEvents.
 */
export * from './AccountDeleted';
export * from './AccountSuspended';
export * from './Currency';
export * from './Email';
export * from './GroupArchived';
export * from './Role';
