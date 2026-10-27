# Exact native Plan submissions versus batching

The retained interim source and local Run from `EARLY-PLAN.md` were unchanged. Both builds used the same one-map collection controls, CPU residency, cached paths, retained paint state, scalar culling, cached colors/objects and empty-GL fast path. Only the retained stream's batching policy differed. The first build imported the integration `9838d9828` stream; the second applied only the production `c600e21f2` singleton correction. No source/compiler file changed between the two builds.

| Diagnostic build | Site Plan paused | Site Plan playing | Long tasks | Actual unique captions |
|---|---:|---:|---:|---:|
| `38ff31148` batched | 16.7 ms p95; 242 intervals | 16.7 ms p95; 243 intervals | 0 | 141 |
| `7f60b063b` exact singleton | 16.8 ms p95; 237 intervals | 16.8 ms p95; 235 intervals | 0 | 141 |

Each window used four seconds of real native pan at DPR 1 in an isolated fresh Chrome profile, on the same 1440 × 913 outer viewport / 1080 × 871 map. Every source path was still submitted in the singleton build. Both tests ended with zero renderer exceptions and zero remaining physical worker targets. These are diagnostic observations on one desktop and an interim source, not a final-source acceptance or a statistical speedup claim. Root/3D GPU work was held; source authoring continued elsewhere, so these are not labelled a fully idle-machine final benchmark.

This establishes that the observed 16.8 ms target can be reached without path batching on this source. It does not claim that batching preserved pixels. The independent raster gate found real AA differences and production removed batching. The retained-state/culling/path-cache changes, together with eliminating empty GL work, are sufficient here; no geometry, labels, line weights or quality settings were deliberately reduced. Final full-source DPR 1/2 and cold/floor qualification remain required.

`plan-singleton-ab.json` contains compact measurements and hashes of the preserved raw receipts. The test-only `LEITBILD_NATIVE_SITE_PLAN_ONLY=1` option explicitly selects this two-window diagnostic; it cannot be relabelled as the complete eight-window product run.
