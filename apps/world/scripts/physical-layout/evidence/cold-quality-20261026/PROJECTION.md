# Drafting projection bottleneck: diagnostic causal comparison

The first actual full-product R3 DPR2 Plan window exposed a regression that
isolated rendering and 3D motion did not reveal. All five layouts were ready,
but whole-site Plan pan had a median RAF interval of 50 ms and p95 of 66.6 ms.

The unchanged `7590a551d` CPU profile identifies the cause: the drafting path
projects every annotation point through `projectGeographic`, which rebuilt the
full camera matrix for each point. Each rebuild reads canvas layout, computes
camera vectors, and scans all admitted scene bounds. The main drawing call was
a small part of the sampled window. The trace's principal projection stack
alone occupied about 3.2 seconds of its 4.25-second window.

The bounded correction `2a02bf586` reuses a camera/resize-revision snapshot for
ground clip X/Y/W and CSS dimensions. Full drawing depth, frustum tests and
wheel cursor unprojection still compute the current matrix. Admitted geometry
can change near/far clip Z without changing ground X/Y/W. No geometry, annotation,
collision, level or visibility policy is reduced.

An intermediate build at `e24d1c216` isolates that production delta on the same
retained R3 source, camera setup and public-UI input sequence:

| Profiled site Plan window | Before | After |
| --- | ---: | ---: |
| Median RAF interval | 50 ms | 16.7 ms |
| p95 RAF interval | 66.6 ms | 16.8 ms |
| Observed RAF intervals, approximately four seconds | 89 | 244 |
| Long tasks | 1 | 0 |
| Summed inclusive `projectGeographic` samples | 3326.95 ms | 45.25 ms |

Both runs retain five ready layouts, the same observed float32/MSAA depth,
color and resolve storage, and the same applicable Canvas2D backing. At the
whole-site zoom, text exceeds its measured footprint envelopes in both cases;
zero text is not used as evidence that room captions work. The product harness
separately requires actual authored HP, LP 1, GEN and TURBINE HALL text at room
scale. This diagnostic does not replace that gate.

Both CPU-profile runs intentionally terminate with an explicit non-qualification
status after preserving their requested profiles. Profiler overhead prevents
these samples being presented as final clean motion acceptance. Final UI/source
quality changes, both-host motion, room text, live owner status and lifecycle
qualification remain separate. Exact commits, source identities, retained
resource inventories, file hashes and raw receipt/profile hashes are in
`projection-causal-ab.json`. The earlier failed text-precondition receipt and
the two explicit diagnostic failures remain in external research storage.
