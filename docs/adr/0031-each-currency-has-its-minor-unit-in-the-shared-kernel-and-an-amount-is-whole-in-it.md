# 31. Each currency has its minor unit in the shared kernel, and every amount is a whole number of it

## Context

Request 40 adds JPY and KRW (no minor unit) and KWD and BHD (thousandths) to Tally's six currencies, which count in hundredths. Until
now "hundredths" was written into three contexts: Ledger and Settlements converted an original amount by multiplying it by the rate,
and Notifications compared a debt with 2000. The storm (`conventions/storms/currency-precision.yaml`) decided four hot spots before
the code.

## Decision

- **The minor unit is the shared kernel's.** `SharedKernel/Domain/Currency.ts` lists the ten currencies, each with its number of
  decimals (`MINOR_UNIT_DECIMALS`), and holds the one conversion (`convertMinorUnits`). Every context agrees on the word, so none keeps
  its own copy. This is a change to the shared kernel, and this ADR is its record.
- **A conversion reads units.** An amount is read in its currency's units, times the rate (what one unit is worth in the other), written
  in the other currency's minor unit, to the nearest whole number, a half up, in exact integer arithmetic (BigInt). Between two currencies
  of hundredths it gives what it gave. The `OriginalAmount` values of Ledger and Settlements, and the provider's fee, convert through it,
  given the group's currency.
- **The reminders' threshold is 20 of the group's currency.** `OutstandingDebt` (the contract of the link Settlements → Notifications,
  ADR 10) gains the group's `currency`, which Settlements reads through `SettlementMembers`; Notifications compares the debt with 20 in
  that currency's minor unit (2000, 20, 20 000). No relationship is added and the context map is unchanged.
- **Nothing is stored converted.** Every amount kept was a whole number of hundredths in a currency of hundredths, which is what it is
  still. No migration. An expense kept with its original no longer checks on reading that its amount is the conversion of the original
  (the group's currency is not in what is kept); it was checked when it was decided.

## Consequences

- A new currency is one line of the table.
- An amount of a group in JPY is a number of yen: the same range, 1 to 100 000 000, means a wider range of money in yen and a narrower
  one in dinars.
