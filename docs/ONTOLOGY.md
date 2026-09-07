# Ontology, Scenarios, Replay & Briefs

GEV's decision layer. Layers render the world; the **ontology** is the system.

## Why

The app's live feeds were per-layer record arrays — good for drawing, wrong
for reasoning. Every "what's near X", every alert, every answer required each
surface to re-implement cross-layer logic. This module set inverts that:

```
feeds → ONTOLOGY (objects + relationships + actions + event log)
              ↓            ↓              ↓            ↓
         analystEngine  alert rules   scenarios     replay/briefs
```

Design doctrine: decision-centric (every artifact shortens the loop from
observation to action), action-closing (alerts carry invocable verbs), and
rehearsable (what-if branches never touch live state).

## Modules

| Module | Role |
|---|---|
| `src/ontology/store.js` | Typed objects (aircraft, vessel, satellite, fire, quake, installation, weather-cell, region) with stable IDs, cross-type relationships (near/inside), a governed action registry, and an append-only ring-buffered event log. Pure; clock injected. |
| `src/ontology/adapters.js` | One-seam-at-a-time migration: ontology-backed `getRecords` for the analyst engine, selection mirroring, cross-type `nearestObjects`. |
| `src/ontology/rules.js` | Alert rules (corridor breach, dark activity, proximity). Alerts carry WHAT / WHY / WHAT NEXT (governed actions). Pure and deterministic. |
| `src/ontology/liveSync.js` | Reads the same `getAnalystRecords` seam the voice engine uses, keeps the store fresh, surfaces only fresh alerts, registers the standard verbs (track/annotate/brief) with host-injected handlers. |
| `src/scenario/engine.js` | What-if branches: stage edits (upsert/remove/weather-front/corridor) on a snapshot branch, recompute rules, diff alerts and objects vs live, apply (with audit marker) or discard. |
| `src/replay/engine.js` | Event-log replay (`stateAt`, cursor with timeline + decision markers) and anomaly detection (dark gaps, teleports, churn). |
| `src/brief/product.js` | The operational brief: current picture + alerts + optional scenario delta → Markdown artifact for copy/download/share. |

## Invariants (tests enforce these)

- Normalization is **lossless** — `object.attrs` keeps the original record.
- Relationships are **total** — a contact leaving a radius loses its edge.
- Edges orient **mover → fixture** — alert subjects are the objects acting.
- Actions are **governed** — guards refuse before handlers run.
- Scenario edits **never mutate live state** — apply/discard are explicit.
- The log is **append-only** — replay and anomaly detection fold the same history.

## Wiring into the running app

```js
import { createOntologyStore } from './src/ontology/store.js';
import { createLiveSync, registerStandardVerbs } from './src/ontology/liveSync.js';

const store = createOntologyStore();
registerStandardVerbs(store, {
  onTrack: (object) => {/* select + camera */},
  onBrief: ({ markdown }) => {/* copy/download */},
});
const sync = createLiveSync(store, dataManager, {
  onAlerts: (fresh) => {/* toast/panel */},
});
sync.start();
```

Everything runs client-side against already-loaded data — the keyless-first
ethos is unchanged.
