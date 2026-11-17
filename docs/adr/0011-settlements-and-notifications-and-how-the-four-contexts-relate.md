# 11. Settlements and Notifications, and how the four contexts relate

## Context

Checkpoint 2's requests (suggested settlements, cash and provider settlements, webhooks late, twice or out of order,
refunds, payout accounts, notices, reminders, settlement history, and leaving with a balance) were stormed before
request 11. The session decided which contexts checkpoint 2 adds, what keeps "no overpayment" when two settlements are
decided at once, how a landed payment reaches the balances, where notices come from, what is declared of request 20,
and where the payment provider is in the model (the session's T6 to T11).

## Decision

- **Settlements (core) and Notifications (generic) are declared now, empty** (T6), before request 11, as checkpoint
  1's session decided for the contexts of this checkpoint; Notifications is a context from its first request.
- **A `SettlementBook` per group** (T7) is the aggregate every settlement of the group is decided in, cash and provider
  alike, with their statuses: it reads the balances through `GroupBalances` (a port Settlements owns, over Ledger's
  read model) and refuses a settlement that would pay more than is owed; two decided at once meet its version check.
- **Ledger reads what was settled** (T8): a port Ledger owns, `SettledAmounts`, answered over Settlements' read model
  when Ledger reads a balance, so that a balance never misses a paid settlement and every decision that reads a
  balance reads the same thing.
- **An expense's notice comes from a fact Ledger publishes** (T9), `ExpenseRecorded`, Tally's first integration event,
  through the outbox; Notifications turns it into one notice per member. **A reminder comes from Notifications' own
  sweep**, which asks Settlements, through a port Notifications owns (`OutstandingDebts`), what each member still owes.
- **Nothing of request 20 is declared** (T10): the session declares what requests 11 to 19 need; request 20's storm
  brings the one relationship it adds (Settlements → Groups, `WaitingPayments`), and the arm declares it then.
- **The payment provider is behind a port Settlements owns** (T11), `PaymentProvider`: a payment link, a refund,
  whether it knows a payout account; its answers are plain values the book and the payout account take or refuse.
  Its webhook is a command anyone may send, and a payment's status moves forward only, which counts a webhook once.

The five relationships are declared `planned` in the context map until the code carries them.

## Consequences

- A settlement's effect on a balance is read, never pushed: Ledger owns the port, so the ledger stays the one place
  balances are read, and a pending payment counts as paid for what is still owed until the provider says otherwise.
- Edits and deletions of an expense tell nobody: only `ExpenseRecorded` is published.

## When to revisit

At request 20, when leaving with a balance passes a debt to the owner and the gap of ADR 1 (an expense at the same
moment as a leave) is closed on the one database; and at checkpoint 3, if the rates service or recurring expenses
need Settlements to react to Ledger's facts rather than read them.
