import { AuditEntry } from '@Contexts/Settlements/Domain/Settlement/AuditEntry';
import {
  AdminLogEntry,
  FeeBorneBy,
  SettlementFee,
  SettlementStatus,
} from '@Contexts/Settlements/Domain/Settlement/DTOs';

/** A settlement as a member reads it: the fields the API answers. `payUrl` is the link of a settlement through the provider only. */
export interface SettlementView {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  status: SettlementStatus;
  at: string;
  payUrl?: string;
  /** The provider's fee and who bore it, for a settlement through the provider asked from request 38 on (request 38). */
  fee?: SettlementFee;
  /** What was paid in another currency, and the rate it was decided at, as the rates service wrote it (request 39). */
  original?: { currency: string; amount: number; rate: string };
  /** Every status the settlement has had, the earliest first, each with when Tally learned it (request 19). */
  history: { status: SettlementStatus; at: string }[];
}

/** A settlement that was paid, as Ledger counts it: who paid whom, and how much. */
export interface PaidSettlement {
  from: string;
  to: string;
  amount: number;
}

/**
 * A settlement the balances count, as Ledger's statement lists it (request 29): who paid whom, how much, how it was paid, and when
 * the balances started to count it, which is when it was recorded in cash, or when the provider said it succeeded.
 */
export interface CountedSettlement {
  id: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  countedAt: string;
}

/** A payment through the provider waiting for the provider to say how it ended: what is still owed counts it as paid. */
export interface WaitingSettlement {
  from: string;
  to: string;
  amount: number;
}

/** A payment through the provider that has not ended yet, pending or refunding: a member may not leave while one of theirs waits (request 20). */
export interface OpenProviderPayment {
  from: string;
  to: string;
}

/**
 * The read side of settlements: read models, never aggregates (QUERY-READ-MODELS). Ledger reads `paidIn` through its own
 * port when it reads a balance (ADR 8), and Settlements reads `waitingIn` when it suggests transfers; a settlement is read
 * only by a member of its group, which the handler asks.
 */
export interface ISettlementQueries {
  /** The settlement with this id, or null if there is none. */
  findById(id: string): Promise<SettlementView | null>;
  /** Every settlement of the group, the most recently recorded first, each with its history (request 19). */
  listGroupSettlements(groupId: string): Promise<SettlementView[]>;
  /** The audit entries of the group's settlements, in the order they were written (request 28). */
  auditOf(groupId: string): Promise<AuditEntry[]>;
  /**
   * Every settlement of the group the balances count, in the order they were recorded: paid, or refunding (the money has not gone back yet).
   * The amount of each is what it settles (request 38), which is its amount when its payer bears none of the fee.
   */
  paidIn(groupId: string): Promise<PaidSettlement[]>;
  /** Who bears the group's provider fee: the owner's decision, or the payee when none was made (request 38). */
  feePolicyOf(groupId: string): Promise<FeeBorneBy>;
  /**
   * Every settlement of the group the balances count (paid, or refunding), in the order they were recorded, each with when the
   * balances started to count it (request 29). The time is the one of its line of history that made it paid.
   */
  countedIn(groupId: string): Promise<CountedSettlement[]>;
  /** Every payment of the group that waits at the provider, in the order they were requested. */
  waitingIn(groupId: string): Promise<WaitingSettlement[]>;
  /** The settlements contested now, the earliest contested first (request 33). */
  contested(): Promise<SettlementView[]>;
  /** The administrators' log, the oldest first (request 33). */
  adminLog(): Promise<AdminLogEntry[]>;
  /** Every payment through the provider of the group that has not ended yet (pending, contested, or refunding), in the order they were recorded (request 20). */
  openProviderPaymentsIn(groupId: string): Promise<OpenProviderPayment[]>;
  /** The payments through the provider, in any group, that this account pays or receives and that have not ended (request 35). */
  openProviderPaymentsOf(accountId: string): Promise<OpenProviderPayment[]>;
}
