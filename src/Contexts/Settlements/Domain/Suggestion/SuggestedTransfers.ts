import { MemberBalance, Transfer } from '@Contexts/Settlements/Domain/Suggestion/DTOs';

/**
 * The transfers that would bring every balance to 0, by the algorithm request 11 states, so that every member reading it sees the
 * same transfers (docs/adr/0012):
 *
 *   1. start from the balances, in the order the members joined;
 *   2. take the member who owes the most (the lowest balance below 0) and the one owed the most (the highest above 0); on a tie,
 *      the one who joined first;
 *   3. the first pays the second the smaller of what the first owes and what the second is owed: one transfer, and both balances
 *      move by its amount;
 *   4. repeat from 2 until no balance is owed or owing.
 *
 * Each step leaves at least one balance at 0, and no balance changes sign, so the transfers are never more than one fewer than the
 * members whose balance is not 0. Balances that do not add up to 0 (a gap the Ledger's reads do not close, docs/adr/0009) stop the
 * suggestion when one side is empty, rather than looping. The function reads nothing and records nothing: a suggestion is a
 * query's answer, not a fact.
 */
export function suggestTransfers(members: MemberBalance[]): Transfer[] {
  const balances = members.map(({ memberId, balance }) => ({ memberId, balance }));
  const transfers: Transfer[] = [];

  for (;;) {
    // The strict comparisons keep the first of two members at the same balance: the one who joined first.
    let payer = -1;
    let payee = -1;
    balances.forEach(({ balance }, index) => {
      if (balance < 0 && (payer < 0 || balance < balances[payer].balance)) payer = index;
      if (balance > 0 && (payee < 0 || balance > balances[payee].balance)) payee = index;
    });
    if (payer < 0 || payee < 0) return transfers;

    const amount = Math.min(-balances[payer].balance, balances[payee].balance);
    transfers.push({ from: balances[payer].memberId, to: balances[payee].memberId, amount });
    balances[payer].balance += amount;
    balances[payee].balance -= amount;
  }
}
