# Ontology provenance contract

Every ontology object carries a first-class `provenance` record alongside its normalized state. This is the evidence contract for downstream alerts, briefs, scenarios, agents, and analyst review.

```js
provenance: {
  provider: 'adsb.lol',
  observedAt: '2026-09-09T15:00:00Z',
  ingestedAt: 1788966000000,
  derived: true,
  derivation: 'gnss-interference-v1',
  sourceIds: ['aircraft:abc123'],
  confidence: 0.73,
  freshness: 'live',
  license: 'provider-terms'
}
```

## Semantics

- `provider`: source/provider or, by default, the ontology layer key.
- `observedAt`: source observation time when available. It is preserved across updates that do not replace it.
- `ingestedAt`: local ontology ingestion time. It advances on every upsert.
- `derived`: true when the object is an analytic inference rather than a direct observation.
- `derivation`: stable identifier for the analytic/derivation method.
- `sourceIds`: ontology object IDs used to produce a derived object. IDs are normalized to strings and de-duplicated.
- `confidence`: normalized to the closed interval `[0, 1]`; `null` means the source supplied no calibrated confidence.
- `freshness`: qualitative state such as `live`, `stale`, or a feed-specific value.
- `license`: optional source/data license or terms identifier for evidence-chain auditing.

## Default behavior

Direct layer ingestion automatically records the layer key as the provider, marks the observation as non-derived, sets freshness to `live`, and records ingestion time. Explicit provenance supplied by a feed takes precedence. Existing provenance fields survive later partial updates unless the feed supplies replacements.

This contract deliberately does not invent confidence for direct observations. Derived feeds should provide a calibrated value when the method supports one.
