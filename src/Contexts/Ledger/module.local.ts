import { Module } from '@Architecture/Application';

/**
 * The Ledger context, declared by the strategic session before the first feature (conventions/domain.yaml, ADR 1).
 * It has no command, query or reaction yet: the features that need it bring them.
 */
export const localLedgerModule = new Module({ name: 'Ledger' });
