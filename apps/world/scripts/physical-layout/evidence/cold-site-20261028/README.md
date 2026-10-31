# Complete PWR site: cold-loading qualification

This receipt covers the retained R6 four-unit PWR and its complete campus on the single native geographic map. It is a local product qualification, not a deployment receipt. `FINAL-COLD-SITE.json` contains exact source identities, measured intervals, coverage checks and SHA-256 references to the preserved raw receipts.

## Balanced cold comparison

The selected cold-path changes were compared in A/B/B/A order. Every trial restarted the Host/World/Agents stack and opened a fresh isolated Chrome. Each restored the same paused Run through `execution.read` and a full Run GET before opening the browser. There was no physical worker, solid geometry or layout-status prewarming. Baseline runtime and built assets were the literal `55771e2ee419527aeefd07350bc6eb40528c1f7f`; candidate product source was `e61b932b8`.

| Trial | All five layouts first drawn | New GPU fence completed |
| --- | ---: | ---: |
| A1 baseline | 3,178.3 ms | 3,230.8 ms |
| B1 candidate | 2,393.4 ms | 2,451.1 ms |
| B2 candidate | 2,802.2 ms | 2,833.3 ms |
| A2 baseline | 3,683.2 ms | 3,711.7 ms |
| Mean baseline → candidate | 3,430.8 → 2,597.8 ms | 3,471.3 → 2,642.2 ms |

The measured mean draw interval improved 24.3%; the completed-fence interval improved 23.9%. These clocks start at the Plan-ready user's 3D action. They do not include earlier Host navigation, and a completed fence is not a physical-monitor presentation timestamp. Remaining true cold work is still material: the paired candidate samples take 2.39–2.80 seconds.

## Final UI checks and separate cold sanity

The final product source is `b94fe94d9`. The tested built checkout `0c2d173e196d2e3bc88ce1a80de11ba3c286a692` has identical World, Host, Agents and package source trees; its additional commits affect diagnostic scripts only. The exact tree fingerprint and empty-diff guard are retained in the JSON. Do not describe the earlier e61 balanced comparison as a repeated A/B estimate of these later UI changes.

A separate final fresh-backend/fresh-Chrome run drew the first family at 1,589.2 ms and **all five layouts at 2,331.6 ms**, with their fence completed at 2,393.1 ms. Plan had prepared zero 3D jobs beforehand. Exactly two family preparation jobs supplied all four unit instances and the campus, with utility routes enabled. This is one final sanity sample, not a new statistical claim.

The final motion checks used public Home camera controls, actual trusted drag input and the same native map. Plan and 3D each passed paused and playing windows at DPR2: all four RAF p95 values were 16.8 ms, with 241–243 measured frames per approximately four-second window, zero long tasks, exceptions, open process windows or unfinished worker work. The Plan observer retains actual ink witnesses while removing expensive per-command diagnostic hooks. Geometry, live status, routes and normal picking remain enabled.

The audit caught a Plan playing regression before release. Unchanged flow glyphs were replacing their presentation objects, while Plan picking unnecessarily ran native ink tests against every member of intersecting BVH leaves and scanned text for objects absent from the Plan. Current-value identity retention and exact conservative per-entry bounds/owner checks remove that redundant work. They do not freeze live values, approximate the final pick, reduce drawing detail or retain historical frames. The final four motion windows pass without additional hidden-state settlement, fixed sleeps or UI layer suppression.

Seventeen final transitions passed, including whole-site Plan/3D returns, scoped turbine hall, operating/lower/stack floors, cutaway changes and five forced-GC checks. The full-site warm 3D return took 67.1 ms to draw; its GC return took 65.7 ms. Warm scoped floor returns took 12.6–24.8 ms. First-time scoped preparation still costs work: approximately 864 ms for the whole turbine scope and 254 ms for its operating floor. These are separate workloads from whole-site cold loading.

Actual equipment and route pointer interactions passed in Plan and 3D. Routes are visible before any Utility routes checkbox action. Hover does not open a faceplate; click opens the existing hosted faceplate. Route cards retain exact graph endpoints, ports, medium and freshly acquired live flow. The child-device action acquires its own subject's readings. All pages close without physical worker leaks.

## Preserved quality and selected architecture

Every balanced trial and the final cold sanity have the same default source-family coverage:

| Source family | Instances | Prepared meshes | Packed render bytes |
| --- | ---: | ---: | ---: |
| Complete R6 unit | 4 | 4,133 | 29,479,104 |
| Complete R6 campus | 1 | 1,879 | 18,587,088 |

These are actual requested default layers, not the separate all-layers fixture. Source compilation, detailed equipment, native Plan drawing, utilities, surfaces and the full site remain intact. [Atomic traversal evidence](../self-pair-overlap-20261028/README.md) records complete geometry/render/picking/ownership identity for both families with the corrected ray comparator. [The transfer proof](../cold-transfer-20261028/README.md) keeps full Plan drawing in its owner and omits only that unused graph from the private solid-worker registration. [Query trials](../overlap-query-20261028/README.md) retain rejected alternatives and the ray-ordering diagnosis. Transparency remains disabled under the existing user decision.

The principal cold-path changes are a standard atomic BVH self-pair traversal, a well-formed deterministic ray centroid comparator, omission of unused Plan payload from solid registration and one caller-scoped batch of owner declarations for live layout reads. The batch reuses admitted current metadata within one request; ordinary fresh readings and caller visibility remain authoritative. It removes repeated per-element declaration work and silent structural truncation without increasing cache limits or adding a permanent cross-request cache. Candidate/polygon/component caps, reduced visual detail, altered polling cadence, eager 3D preloading and delayed interior population are not part of this result.

## Evidence and use by future agents

Complete raw QA is preserved outside the managed worktree at `/Users/hilde/Documents/ChatGPT/plant-layout-research-20261025/draw-stack-audit-20261028/cold-site-20261028/performance-raw`. Its sibling `RAW-MANIFEST.json` lists 2,602 files and 274,415,770 bytes; manifest SHA-256 is `b913c8723c787dc7e8794ff3889a15799ecf4423c82e32e176fbbbb7cd8851d9`. This includes copied private sandbox state, built assets, profiles, screenshots and failed/diagnostic attempts; do not import it into public source or production. The compact JSON records each qualified receipt's exact relative path and hash.

Use the balanced four cold trials for the improvement estimate, the separate final cold receipt for final-source sanity, and the final four motion windows for interaction cadence. Do not pool isolated Bun/V8 geometry CPU clocks, profiled diagnostic runs, rejected query strategies, interrupted samples or drags that accidentally opened process displays into those product results. One Apple M2 and isolated local Chrome are qualified here; WAN and constrained-device performance remain unqualified. The owned test browsers and local stack were stopped after qualification; existing user/demo browser processes were untouched.
