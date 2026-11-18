# 24. Settlements converts a settlement paid in another currency, at the rate offered when it is decided (the rates service is an outside system; no new relationship)

## Context

Request 39 lets a settlement in cash or through the provider be paid in another currency than the group's (Bob owes Ann 50 euros
and has only francs left): the payer states what is paid and in which currency, Tally takes the rate the rates service offers for
that day, and the settlement counts its amount in the group's currency, keeps the rate, and converts the provider's fee at it.
Request 22's rates service is already used by Ledger for expenses in another currency (ADR 13). The storm
`settle-in-another-currency` decided three hot spots with the product's owner: who asks the rates service for Settlements, who
converts and when the rate is fixed, and how the provider's fee is converted.

## Decision

- **Settlements asks the rates service through a port of its own,** `ISettlementRates` (`Settlements/Application/Ports`), answered
  by `HttpSettlementRates` over `RATES_URL`, with the same 5-second limit and the same answers as Ledger's (ADR 13). The rates service
  is an outside system, not a context, as the payment provider is: the two adapters are each in their context's words, and no
  relationship between Ledger and Settlements is added for it. The context map is unchanged.
- **The handler asks, the book decides.** The handler asks the offer for the day of the settlement, in UTC, only for a currency that
  is one of Tally's and not the group's, and passes it to the SettlementBook as a plain value (`RateOffer`, DOMAIN-NON-DETERMINISM).
  The book converts: `OriginalAmount` (`Settlements/Domain/Settlement`) takes the offer and refuses by name when no rate is offered
  (`NoRateOffered`), when the currency is not allowed (`InvalidOriginalCurrency`) or the amount is not 1 to 100 000 000 hundredths
  (`InvalidOriginalAmount`). The group's amount is the original amount times the rate, a half rounded up, in exact integer
  arithmetic, as ADR 12 does for an expense.
- **The rate is kept.** The settlement keeps its currency, its original amount and the rate as the service wrote it (three nullable
  columns, NULL for a settlement in the group's currency), so a payment that lands days later counts the amount decided then, and a
  refund does too. The provider is asked for the payment in the currency it is paid in (the handler gives the original amount and
  its currency); its fee is in that currency and is converted at the same rate before the part the payer bears is taken off.
- **The conversion is in two contexts, on purpose.** Settlements does not import Ledger's `OriginalAmount`: a context's Domain never
  imports another context (CTX-CONTRACTS). The rule is the same in both (a half rounded up, in millionths of the rate), and each
  context's tests hold its own copy to it; a shared kernel value would have been an architecture change for one rounding rule.

## Consequences

- No new context and no new relationship: the context map and the storm's links are unchanged, and `yarn check:conventions` holds the
  code to the declared ones (CTX-MAP-DECLARED). The storm `settle-in-another-currency` owes nothing.
- A settlement's `amount` is the group's, so the balances, the statements, the audit and the notices count the same amount as before.
- Settlements' reads of a settlement gain `original` when it has one; the settlement in the group's currency reads as before.

## When to revisit

When the rate must be asked by the payee rather than the payer (the handler then gives the offer its own date), or when the rounding
rule changes: it changes in both `OriginalAmount`s together, and the two specs hold each to it.
