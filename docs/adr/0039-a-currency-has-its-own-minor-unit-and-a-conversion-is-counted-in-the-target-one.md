# 39. A currency has its own minor unit, and a conversion is counted in the target currency's minor unit

## Context

Request 40 adds four currencies to Tally's six: `JPY` and `KRW` have no minor unit, `KWD` and `BHD` count in thousandths, and the six
that stay count in hundredths. A group going to Tokyo counts in yen, not in hundredths. Every amount of Tally is an integer of its
currency's minor unit: `1250` is 12.50 in `EUR`, 1250 in `JPY` and 1.250 in `KWD`. The storm of the feature
(conventions/storms/currency-precision.yaml) decided where each part lives: the minor unit in the shared kernel, the conversions in the two
contexts that convert (Ledger and Settlements), and the reminders' threshold read through the port Settlements already owns.

No context and no relationship between contexts is added: the context map is unchanged. The shared kernel changes, as the storm says, and
this record says so.

## Decision

- **The shared kernel knows each currency's minor unit.** `SharedKernel/Domain/Currency.ts` lists the ten currencies (`CURRENCIES`), and
  `decimalsOf(code)` answers the number of decimals of a currency's minor unit: 0 for `JPY` and `KRW`, 3 for `KWD` and `BHD`, 2 for the
  rest. Every context agrees on it, and nothing else in the kernel changes.
- **A conversion is computed once, in the kernel, in integers.** `convertMinorUnits(amount, from, rate, to)` reads the amount in `from`'s units,
  multiplies it by the rate (a decimal of at most 6 digits, as a string, as before), and writes it in `to`'s minor unit, rounded to the nearest
  whole number, a half up. It uses `BigInt` and never a float. Ledger's `OriginalAmount` and Settlements' `OriginalPayment` both call it, each
  in its own value; the rule is the same for both, so the storm's hot spot 2 is one function, not two.
- **Between two currencies of the same minor unit, nothing changes.** `convertMinorUnits` gives what it gave for two currencies in hundredths:
  `1000` at `"0.9545"` is `955`. The examples of request 40 hold: 1250 euros at `"161.5"` is `2019` yen, 1000 dollars at `"0.3075"` is `3075`
  thousandths of a dinar, and 10 000 yen at `"0.0062"` is `6200` cents.
- **Nothing stored is converted.** The store keeps integers of the minor unit it was given, and every amount kept before was in hundredths in a
  currency that counts in hundredths. No migration is needed; an earlier amount reads as it did.
- **The provider's fee is in the minor unit of the payment's currency** (request 38). Settlements converts it with the same function, so a fee in
  yen converts to the group's minor unit exactly as an amount does.
- **The reminders' threshold is read in the group's currency.** A reminder is for a debt of more than 20 of the group's currency (request 18,
  request 40): 2000 in the six that count in hundredths, 20 in `JPY` and `KRW`, 20 000 in `KWD` and `BHD`. `reminderAbove(currency)` answers
  it in minor units. `OutstandingDebt`, the Settlements → Notifications owned port (docs/adr/0018), gains a `currency` field, a new field on an
  existing contract and no new relationship. Settlements answers it from the debtor's own group: the debtor is a current member of the group it
  owes in, so `ISettlementMembers.groupOf` answers the group to that member, as it answers the group to any member, and no unscoped port is
  needed for the background sweep.
- **Netting accepts the ten.** A netting is in a currency Tally has (request 32), so it is in yen or dinars when the groups are.

## Consequences

- An expense or a settlement in another currency reads the same `original` as before; only the amount in the group's currency, computed from
  the minor unit, changes, and only where a currency counts in something other than hundredths.
- The API fragment `api/40-currency-precision.yaml` adds the four currencies to the `currency` of a group, a rate, and each `original` of an
  expense or a settlement. The reminder's schema lower bound (`minimum: 21`, in the fragment) is looser than the threshold of each currency
  (2001 for the six, 21 for yen, 20 001 for dinars); every reminder the sweep makes is above it, so the fragment and the code agree on what is
  answered, and the code keeps the threshold.
- An expense's snapshot no longer re-checks that its amount is its original converted, on read. The group's currency is not in the expense's
  row, and reading it would couple the read to Groups; the amount was checked when it was given, as the original's other fields are.
- `OriginalAmount.toGroupAmount` and `OriginalPayment.groupAmountOf` take the group's currency as a parameter, so the conversion is never
  assumed to be in hundredths.

## Revisit when

- A currency is added with a minor unit that is not 0, 2 or 3: the table in the kernel is the one place to change.
- A reminder threshold is set per group rather than as 20 of its currency: the threshold would then move from `reminderAbove` to the group.

See also: docs/adr/0018 (a debt that lasts is reminded by the sweep, which reads what is owed from Settlements), docs/adr/0020 and docs/adr/0021
(an expense in another currency and its rate), docs/adr/0037 (the fee a settlement keeps), docs/adr/0038 (a settlement in another currency).
