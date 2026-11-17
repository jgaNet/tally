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

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
