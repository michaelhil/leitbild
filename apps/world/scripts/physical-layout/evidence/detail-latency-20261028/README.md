# Cold Plan-first detail latency

Baseline application: `b748ae05e39eeb7bc3172bb20981f74753c15c09`, retained R5 sources. All actions use an isolated, paused local Run. No production Run or source was modified.

The [light built-app receipt](baseline-plan-first.json) starts in meshless Plan and proves **zero prior 3D preparations**. The first 3D action takes 4,527.9 ms to the first source-family draw, 7,481.0 ms to both families (four unit placements plus campus), and 7,771.0 ms to the subsequent completion fence. Host navigation to both-family draw is separately 13,317.7 ms. There are exactly two spatial preparation jobs, no runtime exceptions, and no physical worker targets after page closure. These are actual submitted assets and a GPU completion boundary, not physical-monitor presentation times.

Registration takes 1,854.9 ms for the unit and 1,716.0 ms for campus; preparation response intervals are 5,390.8 and 2,652.3 ms. These intervals include worker scheduling/transfer. The [separate Bun phase census](cpu-phases.json) attributes about 77–81% of all-level preparation to surface ownership; its absolute times are not browser timings.

A separate diagnostic EBO inventory positively observed 102 campus and 295 unit operational interior occurrences, including the turbine bodies, generator, bearings, shaft, equipment and routes. The one remaining operational occurrence is **not delayed**: the [untimed exact preparation proof](conditional-route.json) shows all 900 of its faces are conditional alternatives under earlier coincident relief/surge routes. This inventory is separate from the light timing run and does not certify every visible pixel.

The [ownership experiments](ownership-alternatives.json) preserve the negative results. Per-mesh two-stage grouping, exact nonmedian SAH refinement and the existing ray hierarchy all preserve output fingerprints, but do not produce a robust improvement for both families. None was adopted. The long in-process refined sequence was unstable and was not used to rank implementations. Later trials use one engine call per fresh Bun process, with compilation and hashing outside the clock and explicit test-only GC before the call.

[Retained attempts](retained-attempts.json) distinguishes observer/setup failures and a potentially contended diagnostic from the valid light baseline. Raw profiles, screenshots, fixture state and failed attempts remain in the listed local research paths; source blobs and private Run state are not copied into this evidence folder.
