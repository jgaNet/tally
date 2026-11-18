import { ConcurrencyConflictException } from '@Architecture/Domain';
import { IReceiptQueries, ReceiptView } from '@Contexts/Ledger/Application/IReceiptQueries';
import { IReceiptRepository } from '@Contexts/Ledger/Application/IReceiptRepository';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

import { LedgerDatabase } from './LedgerDatabase';

type ReceiptRow = {
  id: string;
  expense_id: string;
  type: ReceiptType;
  size: number;
  url: string;
  version: number;
};

/**
 * The receipts in PostgreSQL (request 26): the repository the attach use case loads and writes, and the read side `GetReceipt` reads. One row per
 * expense, its unique key the backstop of "one per expense". A save is conditional on the version it was read at (CONC-OPTIMISTIC), the check and
 * the write one transaction, so the second of two writers from one version is refused and keeps nothing of its change.
 */
export class SqliteReceipts implements IReceiptRepository, IReceiptQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(expenseId: string): Promise<Receipt | undefined> {
    const row = await this.database.row<ReceiptRow>(
      'SELECT id, expense_id, type, size, url, version FROM ledger_receipts WHERE expense_id = $1',
      [expenseId],
    );
    if (!row) return undefined;
    return Receipt.fromSnapshot({
      id: row.id,
      expenseId: row.expense_id,
      type: row.type,
      size: row.size,
      url: row.url,
      version: row.version,
    });
  }

  async insert(receipt: Receipt): Promise<void> {
    const { id, expenseId, type, size, url, version } = receipt.toSnapshot();
    await this.database.transaction(() =>
      this.database.execute(
        'INSERT INTO ledger_receipts (id, expense_id, type, size, url, version) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, expenseId, type, size, url, version + 1],
      ),
    );
  }

  async save(receipt: Receipt): Promise<void> {
    const { id, type, size, url, version } = receipt.toSnapshot();
    await this.database.transaction(async () => {
      const stored = await this.database.row<{ version: number }>('SELECT version FROM ledger_receipts WHERE id = $1', [
        id,
      ]);
      if (!stored || stored.version !== version) {
        throw new ConcurrencyConflictException('Ledger', 'The receipt changed since it was read');
      }
      await this.database.execute(
        'UPDATE ledger_receipts SET type = $1, size = $2, url = $3, version = $4 WHERE id = $5',
        [type, size, url, version + 1, id],
      );
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async receiptOf(expenseId: string): Promise<ReceiptView | undefined> {
    const row = await this.database.row<Pick<ReceiptRow, 'type' | 'size' | 'url'>>(
      'SELECT type, size, url FROM ledger_receipts WHERE expense_id = $1',
      [expenseId],
    );
    return row ? { type: row.type, size: row.size, url: row.url } : undefined;
  }
}
