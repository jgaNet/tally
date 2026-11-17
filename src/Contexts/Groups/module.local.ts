import { Module } from '@Architecture/Application';

/**
 * The Groups context, declared by the strategic session before the first feature (conventions/domain.yaml, ADR 1).
 * It has no command, query or reaction yet: the features that need it bring them.
 */
export const localGroupsModule = new Module({ name: 'Groups' });
