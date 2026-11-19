# 37. A settlement in another currency: a rates port Settlements owns, and one rate conversion the contexts share

## Context

Request 39 (`api/39-settle-in-another-currency.yaml`) lets a settlement in cash, or through the provider, be paid in another of Tally's currencies than the group's: `original: { currency, amount }` in place of `amount`. The rate is the rates service's (request 22), offered for the day the settlement is decided, in UTC; the payer gives none. The settlement keeps its rate, both amounts, and the rate as the service wrote it, whatever it says later. A fee the provider says in that currency is converted at the same rate before the payer's part is taken off (request 38). The storm (`conventions/storms/settle-in-another-currency.yaml`) decided three hot spots before the code:

- who asks the rates service for Settlements: a port Settlements owns, answered by an adapter over the rates service, an outside system and not a context, as Ledger's offered rate is (ADR 19); no relationship between Ledger and Settlements for it;
- who converts and when the rate is fixed: the settlement book, when it decides, the rate an input it takes (DOMAIN-NON-DETERMINISM), the conversion the one an expense's is (half up);
- the provider's fee in another currency: converted at the settlement's rate, by the same value, before request 38's rule.

Two facts shape the design. The conversion of an amount at a rate is one rule, held by Ledger's expense (`OriginalAmount`, request 21), and Settlements may not import Ledger's Domain (CTX-CONTRACTS, ARCH-INWARD). And the rates service is reached over HTTP at `RATES_URL` and may be slow, down or wrong, as ADR 19 already says.

## Decision

- **A port Settlements owns, `ISettlementRates`** (`rateFor({ from, to, date })`, answering the rate as the service writes it, or `undefined`), in Settlements' Application, in its own words. It is answered by `SettlementRatesOverHttp`, which calls `GET {RATES_URL}/rates/{from}/{to}?date=` with a 5-second limit and maps everything that is not a rate in the request-21 shape to `undefined`. The URL is read when a request comes (ADR 7). Ledger's `IOfferedRates` and this port are two adapters over one outside service, each in its context's words.
- **The use case asks, before the decision, and only for a currency that needs it:** one of Tally's currencies other than the group's, for the group's currency, on the day `now` names in UTC. The decision takes the answer as a plain value (`SettlementGiven.offeredRate`) and checks it: a rate that is not one, or none, refuses the settlement by its name (`NoRateOffered`), before the provider is asked and with nothing kept.
- **The decision converts.** `originalPaymentOf` (Settlements' Domain, `SettlementOriginal.ts`) checks the currency and the amount, takes the offered rate, and answers the amount in the group's currency and the original payment with its rate. Refusals are named: `InvalidOriginalCurrency`, `OriginalCurrencyIsGroupCurrency`, `InvalidOriginalAmount`, `NoRateOffered`. A body with neither `amount` nor `original`, or with both, is refused as `InvalidSettlementAmount` by the decision and as a shape by the transport (400). The amount then passes the settlement's own rules (not more than is owed, at least 1) as any amount does.
- **The rate arithmetic is shared, in the shared kernel.** `isRate`, `rateInMillionths` and `convertAtRate` (amount times rate, to the nearest whole number, a half up, in exact integers) move from Ledger's Domain to `SharedKernel/Domain/Rate.ts`. Ledger's `Rate.ts` re-exports the first two, and `OriginalAmount.groupAmount` calls `convertAtRate`, so an expense and a settlement convert the same way by one rule. The shared kernel already holds the currencies both contexts agree on (ADR 18); a rate's arithmetic is of the same kind, and no context imports another for it.
- **The settlement keeps what was decided.** The book stores each settlement's `amount` in the group's currency, `settled` as before (request 38), and `original` (currency, amount, rate) in three columns; `GET /settlements/{id}` reads `original` back, and a settlement in the group's currency reads as before.
- **The provider is asked in what is paid.** Through the provider, the payment is asked with the original amount and its currency. The fee the provider says is validated in that currency (a whole number from 0, less than the original amount), then converted at the settlement's rate, and only then does request 38's rule take the payer's part off what the payment settles.

## Map

No context and no relationship is added to the context map. The rates service is an outside system, as it was for Ledger (ADR 19), and is not in the map. The links the storm declared (Groups → Settlements, Ledger → Settlements) are unchanged. Nothing under `conventions` changes.

## Consequences

- Settlements' Domain gains `SettlementOriginal.ts` and four exceptions; its read model's `SettlementView` gains `original`; its Application gains the rates port, which `RecordCashSettlement` and `PayThroughProvider` take as a parameter. Their wiring in `module.local.ts` passes `SettlementRatesOverHttp` over `RATES_URL`.
- `SharedKernel/Domain` gains `Rate.ts`. Ledger's behaviour is unchanged: its `Rate.ts` and `OriginalAmount` keep the same exports and results, which Ledger's own tests hold.
- A rates service that is down, slow, or wrong refuses a settlement in another currency by `NoRateOffered`, as it refuses an expense that leaves its rate out. The difference between "no rate" and "no service" that ADR 19 keeps for an expense is not kept here: a settlement's payer never gives a rate, so no service means refused.
- A settlement asked before this request has no `original`, and reads and counts as it did.

## Rejected alternatives

- **Reusing Ledger's `IOfferedRates` through a Ledger → Settlements relationship.** It would add a relationship the storm decided against (no relationship between Ledger and Settlements for the rate).
- **Duplicating the conversion in Settlements.** Two copies of one rounding rule drift apart; the storm says the conversion is the same value's as an expense's.
- **Asking the rates service inside the decision.** The rate is an outside answer, and the decision stays a pure function of the values it is given (DOMAIN-NON-DETERMINISM, ADR 19).
- **Recomputing the amount from the rate later.** The request says a settlement keeps the rate and the amount decided, whatever the service says after; the stored `amount` and `original.rate` are what counts.

## When to revisit

If a second context converts amounts in another currency and needs more than the rule, the conversion moves into a shared value of its own. If settlements must record which source their rate came from, the rate is kept with its source, as ADR 19 would have it.
