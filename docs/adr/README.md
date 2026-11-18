# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-persist-in-sqlite.md) | Accounts persist in SQLite, over one file that every server shares |
| [3](0003-account-registered-is-a-domain-event-before-anything-reacts.md) | AccountRegistered is a domain event before anything reacts to it |
| [4](0004-refusals-answer-422-409-and-401-by-kind.md) | Refusals answer 422 for a rule, 409 for a conflict, and 401 for a refused proof |
| [5](0005-group-is-an-aggregate-and-groupcreated-is-a-domain-event.md) | Group is an aggregate, and GroupCreated is a domain event before anything reacts to it |
| [6](0006-ledger-asks-groups-who-may-be-in-a-split.md) | Ledger asks Groups who may be in a split over a roster, and the expense is an aggregate |
| [7](0007-leaving-keeps-former-members-and-asks-the-balance.md) | Leaving keeps the former member, and Groups asks the balance through a port |
| [8](0008-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [9](0009-suggested-settlements-read-two-owned-ports-and-are-computed-at-the-read.md) | Suggested settlements read two owned ports, and are computed at the read |
| [10](0010-cash-settlements-are-a-book-per-group-and-the-balances-count-them.md) | Cash settlements are decided in a book per group, and the balances count them |
| [11](0011-payout-accounts-are-an-aggregate-per-person-and-the-provider-knows-them.md) | A payout account is an aggregate per person, and the provider says whether it knows it |
| [12](0012-the-inbox-is-in-the-database-and-a-reactions-mark-commits-with-its-writes.md) | The inbox is in the database, and a reaction's mark commits with its writes |
| [13](0013-notices-are-made-from-an-integration-event-and-a-notice-is-an-aggregate.md) | Notices are made from ExpenseRecorded, and a notice is an aggregate that records NoticeIssued |
| [14](0014-reminders-are-a-sweep-over-settlements-debts-and-a-watch-per-debt.md) | Reminders are a sweep in Notifications over Settlements' debts, and a watch per member and group |
| [15](0015-leaving-passes-the-balance-to-the-owner-and-waits-for-the-provider.md) | Leaving passes the balance to the owner, and a payment waiting at the provider keeps a member in |
| [16](0016-another-currency-is-an-original-amount-converted-at-the-rate-stated.md) | An expense in another currency is an original amount converted at the rate stated |
| [17](0017-offered-rates-are-a-port-in-ledger-and-the-band-is-the-expenses.md) | Offered rates are a port Ledger owns, and the 2 % band is the expense's rule |
| [18](0018-recurring-expenses-are-an-aggregate-swept-by-the-ledger-and-recorded-by-a-policy.md) | Recurring expenses are an aggregate, swept by the ledger, and each day is recorded by a policy |
| [19](0019-budgets-are-an-aggregate-per-category-and-a-passed-month-is-published-once.md) | Budgets are an aggregate per category, and a passed month is published once through the existing link to Notifications |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
