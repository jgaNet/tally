# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-sqlite-and-accounts.md) | One SQLite file, and accounts that sign in |
| [3](0003-ledger-asks-groups-for-the-members.md) | Ledger asks Groups who is a member, through a read model Groups exports |
| [4](0004-leaving-a-group.md) | Leaving a group: Groups asks Ledger a member's balance, and a former member keeps its rows |
| [5](0005-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [6](0006-suggested-settlements-carries-the-two-planned-links.md) | Suggested settlements: Settlements carries the two links ADR 5 planned |
| [7](0007-settle-in-cash-and-how-ledger-counts-settlements.md) | Settle in cash: Settlements decides in a book per group, and Ledger counts what was settled |
| [8](0008-pay-through-the-provider-and-what-is-still-owed.md) | Pay through the payment provider: a payment waits, is still owed, and ends once |
| [9](0009-refund-through-the-provider.md) | Refund through the payment provider: the payee asks, and the balances go back when the provider says so |
| [10](0010-payout-accounts-in-settlements.md) | Payout accounts live in Settlements, and a payment is paid to the payee's account |
| [11](0011-notices-and-the-expense-event.md) | Notices: Ledger publishes ExpenseRecorded, and Notifications makes one notice per member |
| [12](0012-reminders-the-sweep-and-the-debt-watch.md) | Reminders: a background sweep keeps a debt watch per member, and Settlements answers what is still owed |
| [13](0013-leaving-with-a-balance.md) | Leaving with a balance: the balance passes to the owner, Groups keeps the fact, and Settlements says whether a payment waits |
| [14](0014-another-currency.md) | An expense in another currency: it keeps what was paid and its rate, and Ledger asks Groups for the group's currency |
| [15](0015-offered-rates.md) | Offered rates: a rates service behind a port Ledger owns, and an expense takes or checks the rate it offers |
| [16](0016-recurring-expenses.md) | Recurring expenses: an aggregate in Ledger, and the background job records each day once |
| [17](0017-budgets.md) | Budgets: a monthly limit per category in Ledger, and a month that passes it is told once |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
