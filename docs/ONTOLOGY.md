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
| `src/ontology/store.js` | Typed objects (aircraft, vessel, satellite, fire, quake, installation, weather-cell, region; Phase 5 adds gps-jam-zone, natural-event, cyber-vuln, space-weather, imagery) with stable IDs, cross-type relationships (near/inside/covers), a governed action registry, and an append-only ring-buffered event log. Pure; clock injected. |
| `src/ontology/adapters.js` | One-seam-at-a-time migration: ontology-backed `getRecords` for the analyst engine, selection mirroring, cross-type `nearestObjects`. |
| `src/ontology/rules.js` | Alert rules (corridor breach, dark activity, proximity, GPS-jam exposure, space weather, KEV additions). Alerts carry WHAT / WHY / WHAT NEXT (governed actions). Pure and deterministic. |
| `src/ontology/liveSync.js` | Reads the same `getAnalystRecords` seam the voice engine uses, keeps the store fresh, surfaces only fresh alerts, registers the standard verbs (track/annotate/brief) with host-injected handlers. |
| `src/scenario/engine.js` | What-if branches: stage edits (upsert/remove/weather-front/corridor) on a snapshot branch, recompute rules, diff alerts and objects vs live, apply (with audit marker) or discard. |
| `src/replay/engine.js` | Event-log replay (`stateAt`, cursor with timeline + decision markers) and anomaly detection (dark gaps, teleports, churn). |
| `src/brief/product.js` | The operational brief: current picture + alerts + optional scenario delta → Markdown artifact for copy/download/share. |

### Phase 5 — derived feeds & the orbital layer

| Module | Role |
|---|---|
| `src/data/gpsJamming.js` | Statistical GPS-interference detection: grids raw ADS-B rows, flags cells where an unusual share of aircraft report degraded nav accuracy (NACp). GEV's own thresholds; emit `gps-jam-zone` objects with severity. |
| `src/data/satPasses.js` | Generalized pass engine on satellite.js: `listPasses` (rise/max/set windows), `groundTrack`, `footprintAt`, `coversAt` for ANY satrec — `issPass.js` stays the voice fast path. |
| `src/data/kevCatalog.js` / `eonetEvents.js` / `spaceWeather.js` / `sentinelCatalog.js` | Keyless public feeds: CISA KEV (`cyber-vuln`), NASA EONET (`natural-event`), NOAA SWPC (`space-weather`), Copernicus STAC acquisition metadata (`imagery`). Pure normalize + injectable fetch. |
| `src/data/adsbRawTap.js` / `tleCatalog.js` | The derived feeds own their inputs: raw ADS-B rows (with `nac_p`) from the origin proxy, and a TTL-cached CelesTrak satrec catalog for the COVERS deriver. The big display layers stay untouched. |
| `src/ontology/derivedFeeds.js` | `syncDerivedFeeds` (same mark-and-sweep invariants as liveSync) + `coversDeriver` — satellite footprint COVERS edges onto regions/installations/jam zones. |
| `src/ontology/phase5Runtime.js` | Per-feed cadences (jam 1 min … KEV 6 h), fail-soft cycles, and the `getSatrecs` source for the store's relationship derivers. |
| `src/ontology/jamZoneOverlay.js` | The flagship made visible: polls `gps-jam-zone` objects and renders each as a translucent severity-colored grid cell draped on the globe. Mark-and-sweep mirrors the ontology — an evicted zone leaves the map. |

New alert rules in `rules.js`: `gps-jam-exposure` (who is inside a zone right now — severity one notch below the zone's), `space-weather` (G/R/S scales at watch+; the natural-cause cross-check for jamming), `kev-recent` (newly listed actively-exploited CVEs).

## Invariants (tests enforce these)

- Normalization is **lossless** — `object.attrs` keeps the original record.
- Relationships are **total** — a contact leaving a radius loses its edge.
- Edges orient **mover → fixture** — alert subjects are the objects acting.
- Actions are **governed** — guards refuse before handlers run.
- Scenario edits **never mutate live state** — apply/discard are explicit.
- The log is **append-only** — replay and anomaly detection fold the same history.
- Derived feeds **own their inputs** — no edits to the big display layers; taps are fail-soft and cache-bearing.
- Feed objects **evict with the feed** — a zone that stops detecting leaves the picture and stops alerting.

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
