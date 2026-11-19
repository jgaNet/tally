# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-in-groups.md) | Accounts in Groups: an aggregate and a domain event, brought in by this decision |
| [3](0003-groups-an-aggregate-and-its-creation-event.md) | Groups: an aggregate and a domain event, brought in by this decision |
| [4](0004-invitations-and-membership-under-concurrency.md) | Invitations: an aggregate of their own, and members of a group under optimistic concurrency |
| [5](0005-expenses-split-between-the-members-of-a-group.md) | Expenses, split between the members of a group, and how Ledger knows them |
| [6](0006-expenses-split-three-ways.md) | Expenses split three ways: equally, by exact amounts, or by shares |
| [7](0007-leaving-a-group-and-the-wirings-that-answer-each-other.md) | Leaving a group, and the two wirings that answer each other |
| [8](0008-the-remainder-goes-to-the-first-member-listed.md) | The remainder of a split goes to the first member listed, not to the payer |
| [9](0009-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [10](0010-suggested-settlements-read-the-balances-through-two-owned-ports.md) | Suggested settlements read the balances through two ports Settlements owns |
| [11](0011-settlement-in-cash-and-the-settlement-book.md) | A cash settlement is decided in a SettlementBook, and Ledger counts it in every balance |
| [12](0012-payments-through-the-provider.md) | A payment through the provider is pending in the SettlementBook, and counted once the provider says it succeeded |
| [13](0013-a-refund-is-a-status-of-the-settlement-the-book-holds-its-live-payments.md) | A refund is a status of the settlement, and the SettlementBook holds the payments that are still live |
| [14](0014-notices-from-an-integration-event-of-ledger.md) | Notices come from ExpenseRecorded, Tally's first integration event, through the outbox |
| [15](0015-reminders-from-a-sweep-over-what-settlements-says-is-owed.md) | Reminders come from a sweep of the background job over what Settlements says is still owed |
| [16](0016-leaving-passes-the-balance-to-the-owner.md) | Leaving a group passes the member's balance to the owner, and Settlements answers whether a payment waits |
| [17](0017-the-writes-of-one-file-are-transactions-that-take-turns.md) | The writes of one database file are transactions that take turns, on one connection per process |
| [18](0018-an-expense-in-another-currency-and-the-group-currency-port.md) | An expense in another currency is counted in the group's currency, through a port Ledger owns; the currencies are the shared kernel's |
| [19](0019-an-offered-rate-is-a-port-ledger-owns-and-no-rate-is-not-no-service.md) | An offered rate is a port Ledger owns; "no rate" and "no rates service" are different answers, and the band is the expense's rule |
| [20](0020-recurring-expenses-a-sweep-of-the-job-and-a-policy-on-its-fact.md) | Recurring expenses: an aggregate of Ledger, a sweep of the background job, and a policy on the day's fact |
| [21](0021-budgets-an-aggregate-that-remembers-its-months-and-a-fact-notifications-reads.md) | Budgets: an aggregate of Ledger that remembers the months it was passed in, decided by a policy on the expense, told to Notifications as `BudgetPassed` |
| [22](0022-split-templates-an-aggregate-of-ledger-and-an-expense-takes-the-template-split.md) | Split templates: an aggregate of Ledger, and an expense takes the template's split, not a reference to it |
| [23](0023-receipts-an-aggregate-of-ledger-kept-behind-a-port-in-an-outside-store.md) | Receipts: an aggregate of Ledger per expense, kept behind a port in an outside store, its type read from the bytes |
| [24](0024-archive-a-group-decided-by-groups-and-refused-by-each-context-through-its-port.md) | Archiving a group: Groups decides and keeps the flag, each context asks through a port it owns and refuses by `GroupArchived` |
| [25](0025-an-audit-of-money-changes-each-context-keeps-its-entries-and-ledger-reads-them.md) | An audit of money changes: each context keeps the entries of its own changes, and Ledger reads them through two owned ports |
| [26](0026-a-statement-lists-the-settlements-the-balances-count-and-is-read-as-csv.md) | A statement lists the settlements the balances count, in the order of their days, and is read as CSV from the same statement; an expense records the instant it was recorded |
| [27](0027-storage-on-postgresql-and-the-one-move-from-the-file.md) | Storage on PostgreSQL: one database, the outbox and the bus's record in it, and one move from the file that is not read again |
| [28](0028-a-merge-moves-the-expenses-and-the-settlements-by-one-fact.md) | A merge moves the expenses and the settlements by one fact, and the people stay in Groups |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
| [29](0029-a-merged-group-is-closed-and-the-passes-it-holds-move-with-its-members.md) | A merged group is closed by its write, and what it holds moves in the merge or in the reactions to it |
| [30](0030-a-netting-is-decided-across-the-books-it-touches-in-one-transaction.md) | A netting is decided across the books it touches, in one transaction, and is an aggregate of its own |
| [31](0031-a-contested-settlement-waits-for-an-administrator-whose-role-is-given-at-sign-in.md) | A contested settlement waits for an administrator, whose role is given at sign-in |
| [32](0032-suspending-an-account-groups-keeps-the-flag-and-each-context-refuses-by-its-port.md) | Suspending an account: Groups decides it and keeps the flag, each context asks through its port and refuses by `AccountSuspended` |
| [33](0033-deleting-an-account-groups-erases-it-and-each-context-refuses-by-its-port.md) | Deleting an account: Groups erases its name and email and keeps its id, each context refuses a deleted account by its port |
