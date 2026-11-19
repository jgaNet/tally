# 30. A settlement in another currency is priced by its book at the rate the rates service offers when it is decided, and keeps that rate

## Context

Request 39 lets a settlement in cash, or through the provider, be paid in another currency of Tally's: Bob owes Ann 50 euros and
pays her in Swiss francs at the day's rate. The payer gives no rate; Tally takes the one the rates service offers. Ledger already
asks that service for expenses (ADR 13). The storm (`conventions/storms/settle-in-another-currency.yaml`) decided three hot spots
before the code: who asks the service for Settlements, who converts and when the rate is fixed, and the provider's fee in another
currency.

## Decision

- **Settlements asks the rates service through a port it owns.** `ISettlementRates` (`Settlements/Application/Ports`) answers the
  rate of one currency to the group's on a day, or `null`. `HttpSettlementRates` answers it over the service's API, with the same
  `RATES_URL` and limit as Ledger's adapter. The service is an outside system, not a context: Settlements and Ledger each have an
  adapter over it, in their own words, and no relationship between the two contexts is added. The context map is unchanged.
- **The day is the decision's, in UTC.** The command reads the application's clock once and asks for the rate of that UTC day. The
  payer does not give a rate, and no offer (`null`) refuses the settlement with `NoRateOffered`: nothing is kept, and the provider is
  not asked.
- **The book converts, once, when it decides.** A decision takes what is paid (`PaidIn`): the group's amount, or the original payment
  with the group's currency and the offered rate. The `OriginalAmount` value checks the currency (one of Tally's, not the group's), the
  amount (1 to 100 000 000 hundredths) and the rate (a decimal number above 0, at most 6 digits), and computes the group's amount as
  the original amount times the rate, to the nearest whole number, a half up, in exact integer arithmetic (as an expense does,
  ADR 12). The settlement's `amount` is that group amount, and the rules of a settlement (never more than is owed) are decided on it.
- **The rate is kept with the settlement.** A settlement stores its original currency, amount and rate in three nullable columns
  (`settlements.original_currency`, `original_amount`, `original_rate`), and reads them back as they were decided. A payment that lands
  later, or a refund, counts the amount decided then. A settlement in the group's currency stores none and reads as before.
- **The provider is asked for what is paid.** A payment through the provider asks for its original amount and currency; the book
  plans it with the rate decided before the provider is asked, and decides again on the same price after the provider answered.
- **The provider's fee is converted at the same rate.** The fee is in the payment's currency, a whole number, 0 or more, below the
  original amount (request 38's check, in that currency). The book converts it at the settlement's rate, the same way as the amount,
  and checks the converted fee is below the group's amount; the payer's part is then taken from the converted fee, as request 38 says.
- **The body's shape is the transport's.** A body gives exactly one of `amount` and `original` (`oneOf`), so neither or both is a
  400. The currency and the amount of `original` are the settlement's to decide, behind the 202, as the expense's are.

## Consequences

- Ledger counts what Settlements settles, in the group's currency, through the same reads as before (ADR 7, ADR 29): Ledger's port
  is unchanged and never sees the currency, the rate or the offer.
- A settlement in another currency that rounds to less than 1 in the group's currency is refused as an invalid amount, as any amount
  below 1 is.
- A rate that changes later changes no settlement: each keeps the rate it was decided at, so the audit and the statement of past
  settlements do not move.
- Two adapters, one per context, read the same `RATES_URL`. A change of the service's API is made in both, which the e2e specs of
  both contexts hold to a stand-in service.
