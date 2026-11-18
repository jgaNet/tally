import { SettlementBook, WaitingPayment } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  FeeBearer,
  ProviderFee,
  Settlement,
  SettlementMethod,
  SettlementStatus,
} from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { OriginalRecord } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/** A status a settlement has had, and when Tally learned it (request 19): one line of its history. */
export interface SettlementStatusEntry {
  readonly status: SettlementStatus;
  readonly at: string;
}

/** What a screen shows of one settlement: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface SettlementView {
  readonly id: string;
  readonly groupId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly method: SettlementMethod;
  readonly status: SettlementStatus;
  readonly at: string;
  /** Every status the settlement has had, the earliest first (request 19). */
  readonly history: readonly SettlementStatusEntry[];
  /** The link the payer pays at: a settlement through the provider only. */
  readonly payUrl?: string;
  /** The provider's fee and who bore it, when it was asked for with request 38 (a settlement through the provider only). */
  readonly fee?: ProviderFee;
  /** What it was paid in, when it is paid in another currency, at the rate decided then (request 39). */
  readonly original?: OriginalRecord;
}

/**
 * The store of settlements, the port the use cases write and read through (ADR 10). `versionOf` is the version a group's book is
 * at, 0 when no settlement has been decided in it; `waitingOf` is the payments of the group waiting at the provider, which the book
 * counts as paid for what is still owed; `save` keeps a decided settlement or its new status, and stores the book at its version + 1,
 * only while the book is still at the version it was read at, and refuses it with a ConcurrencyConflictException otherwise
 * (CONC-OPTIMISTIC); `viewOf` reads a settlement as it was saved, or `undefined` when there is none; `settlementOfPayment` reads the
 * settlement the provider's payment id names, or `undefined` when no settlement does; `settlementOf` reads the settlement by its own id,
 * as the domain keeps it (with the provider's payment), for a refund. `learnedAt` is when Tally learned the settlement's status (request 19):
 * `save` writes it as the settlement's newest history line, in the same transaction as the status, so a settlement's history is the
 * statuses it has had, each with its time. `viewsOfGroup` reads the settlements of a group, the most recently decided first.
 * `viewsContested` reads the settlements contested now, the earliest contested first (request 33).
 */
export interface ISettlementStore {
  versionOf(groupId: string): Promise<number>;
  waitingOf(groupId: string): Promise<WaitingPayment[]>;
  save(book: SettlementBook, settlement: Settlement, learnedAt: string): Promise<void>;
  viewOf(settlementId: string): Promise<SettlementView | undefined>;
  viewsOfGroup(groupId: string): Promise<SettlementView[]>;
  /** The settlements contested now, the earliest contested first (request 33). */
  viewsContested(): Promise<SettlementView[]>;
  /** Who bears the group's provider fee, as its owner decided: the payee until then (request 38). */
  feePolicyOf(groupId: string): Promise<FeeBearer>;
  /** Stores the book's fee policy at its version + 1, only while the book is still at the version it was read at (CONC-OPTIMISTIC). */
  saveBook(book: SettlementBook): Promise<void>;
  settlementOfPayment(paymentId: string): Promise<Settlement | undefined>;
  /** The settlement as the domain keeps it, with its provider's payment, or `undefined` when there is none (request 15). */
  settlementOf(settlementId: string): Promise<Settlement | undefined>;
  /** The ids of the settlements of a group, in the order they were decided (feature 31). */
  settlementIdsOf(groupId: string): Promise<string[]>;
  /**
   * Moves the settlements of the group merged into the group the book is of (feature 31, request 31), with their audit entries, in the
   * transaction of the move: the book is stored at its next version, as a settlement is, and the merged group's book is gone.
   */
  absorb(book: SettlementBook, mergedGroupId: string): Promise<void>;
}
