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

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
