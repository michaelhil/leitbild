# Cold physical-layout loading: retained R2 comparison

This folder preserves the controlled comparison of baseline `e0ff789dd` with
integrated candidate `1079c5360`. Both applications restore the same paused Run
and draw four instances of the exact retained R2 unit plus its campus. The new
R3 architectural source is a separate workload and is not a claimed speedup.

## Actual product result

| Checkpoint, milliseconds | Baseline | Candidate |
| --- | ---: | ---: |
| Cold browser open: first requested 3D asset draw | 1787.6 | 1817.6 |
| Cold browser open: complete five-layout settled GPU checkpoint | 3332.3 | 2270.6 |
| Fresh browser owner: first requested draw | 1245.1 | 1051.4 |
| Fresh browser owner: complete five-layout settled GPU checkpoint | 2779.2 | 1398.1 |

Complete cold-site settlement is 31.9% shorter in this pair. The first requested
asset draw is essentially unchanged and slightly slower. Fresh-browser-owner
settlement is 49.7% shorter. These milestones are distinct; GPU completion does
not claim the time pixels reach a physical monitor.

All fifteen public-UI actions completed with no exceptions, GL errors, observer
errors or pending jobs. Actual cold draw observations include four unit
instances and one campus instance. Selected-owner actions record fresh paused
status for the current 108 modelled subjects. The fixture's eleven retained Run
files matched the original before each server started. No saved state or
retained source blob is published here.

The baseline preparation schedule serializes unit work (609.7–1749.5 ms after
the open action), then campus work (1796.8–3291.4 ms). Candidate unit work
(685.4–1775.0 ms) overlaps campus work (784.0–2239.1 ms) on another worker. Exact
source compilation and trust checks still occur. The observer sees one
preparation worker before and two after.

This is one quiet paired run on one device, comparing a combined integrated
candidate. It is not a population estimate or an attribution of every change
to the worker pool. Fresh Chrome profiles use a 1440 × 913 CSS-pixel viewport,
DPR 1 and Headless Chrome 156. Both rebuilt loopback Host/World stacks use the
same read-only HTTPS proxy for published vector/reference assets. The proxy
does not carry production Workspace or Run routes. Other agents held builds,
tests and GPU probes during both accepted samples. A missing-map calibration
failure and a build-contended functional run remain in external research
storage and are excluded from this timing pair.

## Structural change and isolated causal control

Preparation workers have source-family affinity. Placements and views of the
same geometry share registration and exact-key work; independent demanded
families can run concurrently. The budget derives from reported logical CPU
capacity, reserving the main thread's share, with a real serial worker when no
capacity is reported. It is a scheduling policy rather than core pinning or
accounting for every unrelated browser worker. There is no arbitrary worker,
scene, candidate or detail cap. Workers exist only for actual demand. New
families select existing workers by pending work before registered storage when
capacity is occupied. Cancellation and error handling remain caller/family
scoped; last leases and job pins release ownership.

The separate real Bun-worker control prepares the same R2 unit/campus All views
with serial capacity and with eight reported logical CPUs. The latter has a
budget of seven but creates only the two demanded workers. Completion changes
from 2567.5 to 1651.4 ms (35.7% shorter), while the first unit response changes
from 1120.4 to 1225.3 ms. Prepared hashes are identical, including geometry,
material roles, ownership alternatives, Plan metadata, picking hierarchies and
render buffers. Registered source storage is 41,332,188 bytes and retained
typed prepared storage is 83,876,888 bytes in both runs. After close, workers,
sources, jobs, pins, queues and retained-pool storage are zero. Extra worker
runtime and overlapping temporary allocations may increase peak process
memory; equal typed storage is not evidence of equal peak RSS.

The stage attribution records why concurrency matters: ownership preparation
dominates this fixture (unit All 736.1 ms; campus All 1222.4 ms), while retained
source validation is 6.5/13.8 ms. Inclusive source compilation is 348.6/417.5 ms.
Parsing, validation and admission probes deliberately repeat work to attribute
it; do not sum them with inclusive compilation. These are CPU-stage samples,
not network, browser queue, GPU upload or painted-frame measurements.

## Complete source-cache delivery and lifetime

The subsequent cache correction `5d8f66667` is a preservation fix, not an
additional timing claim. Weak discovery still holds only a `WeakRef` to the
objects array. A `WeakMap` keyed by that externally carried array preserves the
complete intrinsic delivery, including annotations. Every cold, pending and
warm caller rebinds owner, placement and group headers and still validates its
retained authority. A dropped first wrapper no longer loses drafting metadata
while another host retains its objects.

Production reference audit: the pending map holds a compilation promise only
until its `finally` deletes that entry; completed scene wrappers are never
stored in a strong cache. The intrinsic map is an ephemeron keyed by the
objects array, so its value referring to that same array does not independently
retain the key. The direct compiler returns its scene without a compiled-scene
cache. Browser source workers terminate after response or failure. Browser
worker/GPU cleanup requires its separate lifecycle gates.

Normal cache tests assert complete metadata, shared geometry, distinct instance
headers, cold concurrent acquisition and refusal of unadmitted edits. They do
not require an ECMAScript implementation to collect an object on a schedule.
The isolated fresh Bun-process witness ends each async lifecycle stack before
the next independent host task and requests collection once at each transition,
without retry loops or waiting until collection succeeds. It observed the first
wrapper collected while objects alone remained, preserved all 241 annotations
on warm acquisition, then observed both wrappers and objects collected after
the last carrier was released. This is an actual Bun observation, not a VM
guarantee or whole-browser memory proof.

## Evidence and reproduction

- `product-r2-comparison.json`: every action, exact retained Design/compiler
  identities, observed instance counts and raw product receipt hashes.
- `parallel-worker-r2.json`: real-worker timing, exact output hashes and
  before/ready/closed ownership counters.
- `stage-r2.json`: CPU attribution on the exact admitted R2 fixture.
- `source-cache-isolated-gc.json`: the single isolated lifecycle observation on
  the then-current R3 source; its exact Design/compiler and production file
  hashes are recorded. It does not qualify later R3 source revisions.
- `manifest.json`: complete tested commits, production source file hashes,
  external raw receipt hashes and published evidence hashes. The frozen product
  instrumentation hash is identical before and after.

From `apps/world`, the committed tools are:

```sh
bun scripts/physical-layout/cold-stage-probe.ts
bun scripts/physical-layout/parallel-preparation-probe.ts
bun scripts/physical-layout/source-cache-gc-probe.ts
bun test tests/physical-source-cache.test.ts tests/physical-preparation-leases.test.ts tests/physical-render-assets.test.ts
bun run tsc --noEmit
```

For an actual retained-Run product comparison, separately build each recorded
application commit, restore the same closed local fixture, and run the frozen
`loading-product-probe.ts` against its loopback published Host URL with
`LEITBILD_LOADING_TESTED_COMMIT` set to that built commit. The observer records
dispatch → matching prepared asset draw → GPU completion, never substitutes a
DOM-ready flag or a fixed settlement sleep. Exact fixture source identities
must match this receipt; running the current default R3 scenario is a different
qualification workload.
