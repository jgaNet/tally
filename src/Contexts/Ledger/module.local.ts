import { LiteModule } from '@Architecture/Application/Lite/LiteModule';

/**
 * The Ledger context, declared by the strategic session before the first feature (conventions/domain.yaml, ADR 1).
 * It has no use case or reaction yet: the features that need it bring them.
 */
export const localLedgerModule = new LiteModule({ name: 'Ledger' });
