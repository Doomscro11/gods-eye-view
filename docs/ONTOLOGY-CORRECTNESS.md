# Ontology correctness invariants

This note records two invariants enforced by the scenario and replay engines.

## Scenario conflict detection

`eventSeq` is the audit sequence. It advances for state changes and non-state audit events such as relationship recomputation and analyst notes.

`stateRevision` is the scenario-conflict sequence. It advances only when live ontology state changes (object upsert/remove or an applied restore).

Scenario staleness MUST compare against `stateRevision`, not `eventSeq`, so compare/recompute/audit operations cannot make a branch stale by themselves.

## Bounded replay history

The in-memory event log is bounded. When an event rolls out of the buffer, the store folds it into a replay baseline containing the object state represented by all discarded events.

Replay MUST reconstruct from:

1. the current replay baseline; then
2. retained events with sequence numbers greater than the baseline sequence.

A replay cursor MUST refuse timestamps older than the retained baseline because exact reconstruction before that point is no longer available in memory.

These invariants are regression-tested in `src/scenario/workflowRegression.test.mjs` and `src/replay/engine.test.mjs`.
