# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-one-sqlite-file-for-what-the-application-knows.md) | One SQLite file for what the application knows |
| [3](0003-ledger-reads-who-may-be-in-a-split-from-groups.md) | Ledger reads who may be in a split from Groups, through a port it owns |
| [4](0004-groups-and-ledger-ask-each-other-through-ports.md) | Groups and Ledger ask each other through ports, and a leaver is kept |
| [5](0005-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [6](0006-settlements-carries-its-two-ports-and-the-suggestion-is-computed.md) | Settlements carries its two ports, and the suggestion is computed at the read |
| [7](0007-ledger-counts-what-is-settled-and-settlements-decides-on-the-balances.md) | Ledger counts what is settled, and Settlements decides on the balances |
| [8](0008-a-payment-through-the-provider-is-pending-until-the-provider-says-how-it-ended.md) | A payment through the provider is pending until the provider says how it ended, and only then counted |
| [9](0009-a-notice-is-made-from-the-expense-recorded-fact.md) | A notice is made from the ExpenseRecorded fact, and nothing else of Ledger's |
| [10](0010-the-sweep-keeps-debts-through-an-owned-port-and-a-week-is-kept-per-member.md) | The background sweep keeps each debt through an owned port, and a reminder is kept once a week per member and group |
| [11](0011-a-member-leaves-whatever-their-balance-and-the-balance-passes-to-the-owner.md) | A member leaves whatever their balance, and the balance passes to the owner in the same step |
| [12](0012-an-expense-in-another-currency-is-converted-once-and-kept-as-given.md) | An expense in another currency is converted once, in exact arithmetic, and kept as given; the group's currency is read through an owned port |
| [13](0013-an-offered-rate-is-a-port-the-expense-takes-or-checks-within-two-percent.md) | An offered rate is a port the expense takes or checks within 2 %, and its source is kept |
| [14](0014-a-recurring-expense-is-an-aggregate-of-ledger-and-its-day-names-its-expense.md) | A recurring expense is an aggregate of Ledger, and its day names the expense it records |
| [15](0015-a-budget-is-an-aggregate-of-ledger-that-remembers-its-passed-months-and-tells-notifications-through-the-existing-link.md) | A budget is an aggregate of Ledger that remembers the months it was passed in, and tells Notifications through the link they already have |
| [16](0016-a-split-template-is-an-aggregate-of-ledger-that-an-expense-is-split-by-as-given.md) | A split template is an aggregate of Ledger, and an expense is split by it as if its split had been given |
| [17](0017-a-receipt-is-an-aggregate-of-ledger-kept-in-an-outside-store-behind-a-port.md) | A receipt is an aggregate of Ledger, kept in an outside store behind a port Ledger owns |
| [18](0018-a-group-is-archived-by-its-owner-and-every-change-in-it-is-refused-by-one-name.md) | A group is archived by its owner, decided by Groups, and every change in it is refused by one name |
| [19](0019-each-context-writes-its-own-audit-entries-in-its-transaction-and-ledger-reads-them-through-owned-ports.md) | Each context writes its own audit entries in the transaction of its change, and Ledger reads them through ports it owns |
| [20](0020-a-members-statement-lists-the-settlements-the-balances-count-and-is-read-as-csv.md) | A member's statement lists the settlements the balances count, and is read as CSV through a query of its own |
| [21](0021-the-application-keeps-its-state-in-postgresql-and-moves-its-sqlite-file-into-it-once.md) | The application keeps its state in PostgreSQL, and moves what its SQLite file held into it once |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
