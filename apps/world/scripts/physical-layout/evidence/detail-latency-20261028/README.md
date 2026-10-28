# Cold Plan-first detail latency

Baseline application: `b748ae05e39eeb7bc3172bb20981f74753c15c09`, retained R5 sources. All actions use an isolated, paused local Run. No production Run or source was modified.

The [light built-app receipt](baseline-plan-first.json) starts in meshless Plan and proves **zero prior 3D preparations**. The first 3D action takes 4,527.9 ms to the first source-family draw, 7,481.0 ms to both families (four unit placements plus campus), and 7,771.0 ms to the subsequent completion fence. Host navigation to both-family draw is separately 13,317.7 ms. There are exactly two spatial preparation jobs, no runtime exceptions, and no physical worker targets after page closure. These are actual submitted assets and a GPU completion boundary, not physical-monitor presentation times.

Registration takes 1,854.9 ms for the unit and 1,716.0 ms for campus; preparation response intervals are 5,390.8 and 2,652.3 ms. These intervals include worker scheduling/transfer. The [separate Bun phase census](cpu-phases.json) attributes about 77–81% of all-level preparation to surface ownership; its absolute times are not browser timings.

A separate diagnostic EBO inventory positively observed 102 campus and 295 unit operational interior occurrences, including the turbine bodies, generator, bearings, shaft, equipment and routes. The one remaining operational occurrence is **not delayed**: the [untimed exact preparation proof](conditional-route.json) shows all 900 of its faces are conditional alternatives under earlier coincident relief/surge routes. This inventory is separate from the light timing run and does not certify every visible pixel.

The [ownership experiments](ownership-alternatives.json) preserve the negative results. Per-mesh two-stage grouping, exact nonmedian SAH refinement and the existing ray hierarchy all preserve output fingerprints, but do not produce a robust improvement for both families. None was adopted. The long in-process refined sequence was unstable and was not used to rank implementations. Later trials use one engine call per fresh Bun process, with compilation and hashing outside the clock and explicit test-only GC before the call.

[Retained attempts](retained-attempts.json) distinguishes observer/setup failures and a potentially contended diagnostic from the valid light baseline. Raw profiles, screenshots, fixture state and failed attempts remain in the listed local research paths; source blobs and private Run state are not copied into this evidence folder.

After qualification, the owned QA services were stopped and all 240 ignored research files (154,597,830 bytes) were copied and SHA-verified under `/Users/hilde/Documents/ChatGPT/plant-layout-research-20261025/draw-stack-audit-20261028/performance-raw`. `PRESERVATION-MANIFEST.json` there records every relative path/hash and closure proof; its SHA-256 is `4d2b302989b27acc7fe8af6c7671af400654fb6bb35a9bebe9b4a30407fb25c8`. Original managed-worktree `.health/layout-detail-latency/` paths in receipts are historical: resolve their relative suffix under this preserved root after worktree archival. Public compact evidence and reproducible scripts remain in Git.

## Qualified candidate

The [final comparison and R6 receipt](FINAL-DETAIL-LATENCY.json) tests application `53b443ed9709069139acfa2ddbd22bbb79a7f3cb`. The adopted changes are a standard centroid hierarchy for ownership queries and reuse of the already admitted scene inside its private preparation worker. Source/shape validation remains at the Pack boundary. Geometry, ownership, render and pick output equality is tested separately; no detail is removed.

On the **same retained R5 source and identical observer**, cold Plan-ready → both 3D source families falls from **7,481.0 to 2,987.6 ms**, and the completion fence from **7,771.0 to 3,015.5 ms**. The preparation worker bundle shrinks from 140.28 to 42.50 kB; the source-compiler worker artifact is unchanged. Observed Host-navigation times are retained for both runs, but their backend restoration state differs, so they are not a controlled navigation-speedup claim.

Fresh R6 uses different, explicit source pins and is a separate qualification: after backend restart, Plan → all five 3D placements takes **3,191.1 ms** (fence 3,217.8 ms). Mode return and forced-GC return take 70.5/68.5 ms to both-family draws with zero preparations. First scoped hall/operating views take 1,105.5/309.1 ms; cached floor/cutaway/GC returns request zero preparations. Plan requests no solid preparation. One later focused collection-count test error is preserved; the corrected floor-only continuation binds the exact authored scope key.

Four R6 full-site DPR2 motion windows (Plan/3D × paused/playing) have 16.7–16.8 ms p95 RAF intervals and zero observed long tasks. Plan uses the minimal observer: 137 actual completed ink paints in each window, with per-primitive hooks absent during motion. Input is paced by CDP acknowledgements plus 16 ms; these results do not claim 60 Hz input, 60 Hz ink or monitor presentation. All browser processes close and physical worker targets reach zero after each page closure.

The remaining cold first-3D cost is about three seconds on this local machine. This is not the previous warmed 75 ms result, a WAN benchmark, or a repetition of the earlier R5 32-window matrix.
