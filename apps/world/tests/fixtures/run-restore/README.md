# Retained Run fixtures

The gzipped `run/` files are the original captured Run state. Do not replace them with a newly created Run to make a restoration test pass. Each manifest also depends on an immutable Scenario Definition Revision stored outside the Run directory.

`scenario-definition.json` supplies that exact historical dependency. For the pre-existing fixtures, it was recovered from the source commit named in `meta.json`:

| Fixture | Source commit and path | Required revision |
|---|---|---|
| `halden-loop` | `37e4431bb`, `apps/world/src/scenarios/halden-offsite-power-restoration.scenario.json` | `revision-9c61e1fb0b0e13f234951a5942ad4173` |
| `einsatz-supply-run` | `bacf7a115`, `apps/world/src/scenarios/supply-run.scenario.json` | `revision-d40cb8e16e9329e80a42cc541ed3cd8c` |

Parsing each historical document with the Scenario schema produces exactly the revision ID and full content digest pinned in its captured manifest. The unpacker verifies both through the real Scenario Library. Today's bundled seed may advance the current head; the historical revision file remains available to the saved Run. This is dependency completion, not a state recapture, migration or alias to the current Scenario.

The capture tool now retains the pinned Definition document along with new fixtures. It refuses capture when that dependency is missing or does not match the Run manifest.

## Current PWR model boundary

The owner authorized fresh PWR Runs for the 29 October 2026 controller and resolved component-library identity change. The retained `halden-loop` checkpoint belongs to model `47b82339adddd913ef20d24294ae9c595b104d1c10148bcfb5943bc30aeaf3ea`; it is historical evidence and must now fail clearly when loaded against the changed model. The refusal test checks that its stored runtime file is not rewritten. Its original capture, Scenario dependency and provenance remain intact.

Current-model restoration is tested separately in `tests/run-restore.test.ts`. The test creates the actual bundled four-unit loss-of-offsite-power Scenario in a fresh local data directory, issues controller selections through normal operator Capabilities, advances the real coupled simulation through its scheduled grid fault, shuts down the registry to persist its actual state, then opens a new registry and reloads that exact Run. It checks the saved objects, clock, journal, unit-specific controller selections, offsite-loss feedback and continued simulation. It does not stamp an old digest, add saved variable slots, migrate a checkpoint, or replace this historical artifact. The fresh test data is removed afterwards.
