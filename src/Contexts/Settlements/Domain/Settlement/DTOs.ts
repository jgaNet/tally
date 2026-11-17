/** How a settlement was paid: in cash, handed over between the two members (request 12). */
export type SettlementMethod = 'cash';

/** Where a settlement stands: a cash settlement is paid the moment it is recorded (request 12). */
export type SettlementStatus = 'paid';

/** A settlement as it is recorded and as `GetSettlement` answers it (request 12). `from` paid `to`, `at` when it was recorded. */
export interface SettlementView {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  at: string;
}

/** What one member paid and received in the settlements of a group: their balance moves by `paid` less `received`. */
export interface SettledMember {
  memberId: string;
  paid: number;
  received: number;
}
