# 38. Currency precision: each currency counts in its own minor unit, held by the shared kernel, and conversions go by what one unit is worth

## Context

Request 40 (`api/40-currency-precision.yaml`) adds four currencies to Tally's six: `JPY` and `KRW`, which have no minor unit, and `KWD` and `BHD`, which count in thousandths. Every amount of the product is then a whole number of the minor unit of the currency it is in: `1250` is 12.50 euros, 1250 yen, 1.250 dinars. A conversion between two currencies is what one unit of each is worth in the other, and the reminders (request 18) compare a debt with 20 of the group's currency. The storm (`conventions/storms/currency-precision.yaml`) decided four hot spots before the code:

- where a currency's minor unit lives: in the shared kernel's `Currency`, the list every context agrees on (ADR 18);
- what changes in the conversions: the original amount of Ledger and Settlements reads the amount in its currency's units and writes the result in the group's minor unit; between two currencies that count in hundredths it gives what it gave;
- the reminders' threshold: 20 of the group's currency, which Notifications compares with a debt it is told in the group's currency, through the `OutstandingDebts` contract it already has (a new field, no new relationship);
- nothing stored is converted: every amount kept was a whole number of a currency's hundredths, and it still is.

Two facts shape the design. A group's currency reaches Notifications only through Settlements' read of the members (`ISettlementMembers`), and the expense record does not carry its group's currency.

## Decision

- **The shared kernel holds the minor unit.** `SharedKernel/Domain/Currency.ts` lists the ten currencies (`CURRENCIES`) with the decimals of each (`minorUnitDecimals`): 0 for `JPY` and `KRW`, 3 for `KWD` and `BHD`, 2 for the six. `minorUnitDecimals` of a code that is not one is a programming error and throws.
- **One conversion, between two minor units.** `convertAtRate(amount, rate, from, to)` (`SharedKernel/Domain/Rate.ts`) is the amount times the rate, times 10 to the power of the decimals of `to` and divided by 10 to the power of those of `from`, rounded to the nearest whole number, a half up, in exact integers. Between two currencies of the same decimals it is the amount times the rate, as before.
- **Every conversion names both currencies.** `OriginalAmount.groupAmount(groupCurrency)` (an expense, request 21), `originalPaymentOf` (a settlement, request 39) and the provider fee's conversion (request 38, whose `conversion` takes the rate and both currencies) pass the original's currency and the group's.
- **The debt carries its group's currency.** `OutstandingDebt` gets `currency` in Settlements' Domain and in Notifications' Application. `ISettlementMembers.allMembers` and Groups' `currentMembers` answer each group's currency, read by the same join that reads its members. `OutstandingDebtsOfBalances` passes it on, and `OutstandingDebtsOfSettlements` maps it.
- **The reminder threshold is per currency.** `reminderThresholdOf(currency)` is 20 units of the currency in its minor unit: 2000, 20, 20 000 for the three precisions. `decideSeeDebt` takes it as `threshold` in `SeeDebt`; the sweep gives a member who owes nothing a threshold of 0, so their watch is cleared as before.
- **Nothing is stored converted.** No column changes and no migration: each stored amount is already a whole number of its currency's minor unit, and it reads as it did.

## Map

No context and no relationship is added. The link Settlements → Notifications (`OutstandingDebts`) is declared already and keeps its contract, with the currency added to what it answers. Nothing under `conventions` changes except the storm, and the shared kernel's change is said here, as the storm asks.

## Consequences

- **A read no longer re-checks an expense's amount against its group's currency.** `Expense.fromSnapshot` used to refuse a stored expense whose amount in the group's currency was not what its original gave. The group's currency is not in an expense's record, and Ledger's read does not reach Groups for it, so that check cannot be made at a read. It is still made when the expense is recorded or edited, where the decision has the group's currency; a row changed by hand is not refused on read.
- The read check's removal is the only behaviour the feature takes away from an earlier rule; amounts, splits and the six currencies are otherwise as they were.
- `Groups`' error for a currency that is not one names the ten.
- A settlement's fee converts at the settlement's rate from the original's currency into the group's, which is the same rule.

## Rejected alternatives

- **Storing the group's currency with each expense**, so that the read check could be made. It needs a column, and the rows written before it cannot be filled from inside Ledger without reading Groups' table.
- **Ledger and Settlements each keeping their own table of currency decimals.** Two lists drift apart; the shared kernel is where every context agrees on a currency (ADR 18).
- **Notifications reading the group's minor unit from Groups.** It would be a new relationship for a number the debt already has, in the group's currency, through a contract that is there.
- **Scaling amounts when they are stored.** It would change what the earlier amounts read as, which the request forbids.

## When to revisit

If a currency needs a minor unit with more than three decimals, `minorUnitDecimals` and the rate's precision (six digits after the point) are the first to change. If the read check on an expense must come back, the group's currency belongs in the expense's record, with its rows filled from Groups by a migration that Ledger's owner reviews.
