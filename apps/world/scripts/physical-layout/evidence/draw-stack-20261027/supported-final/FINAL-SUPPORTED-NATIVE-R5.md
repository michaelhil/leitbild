# Final supported native R5 qualification

Tested app: `954af6cf2fcf5df924a6935780fde293b4049386`. One native geographic map, opaque architecture and cutaway. Fractional opacity controls are withdrawn. Source and compiler pins are unchanged. The QA production-source diff against this app commit is empty.

All **32 motion windows** passed with RAF p95 **16.7–16.8 ms** and **zero long tasks**: default and all declared layers, site and room, Plan and 3D, paused and playing, DPR 1 and 2. Defaults include utility routes. Plan windows used native Canvas methods with one clear timestamp and a one-shot actual model-affine/completion witness; captions/source/pose/coverage were checked outside each window. The materially instrumented candidate Plan control remains retained at 33.3–33.4 ms.

A separate higher-rate Plan trial received 225 trusted held-pointer moves at 55.64 Hz and completed 222 paints with 214 distinct affines. RAF p95 was 16.7 ms. Clear intervals were 16.8 ms median/27 ms p95. Actual model translations followed the latest input delta with observed error up to 0.803 px. Latest-input to Canvas-completion upperbound was 11.8 ms median / 13.5 ms p95, with no accumulating lag between the first and second halves. This is synchronous Canvas completion, not physical-screen presentation; the browser skipped some 60 Hz attempted deadlines. Independent actual Plan captures before and after the fix matched exact RGBA at both DPRs for site and operating room.

| Cold milestone | Host navigation | Full-site action |
|---|---:|---:|
| First requested 3D draw |3949.3 ms |2189.4 ms |
| All required source-family draws |5509.7 ms |3749.8 ms |
| All-family GPU fence |5538.5 ms |3778.6 ms |

**Full-site cold completion still takes 5.54 seconds in this sample.** This is a retained limitation, not a claimed solved cold-loading target or controlled speedup. Two real families supply four unit placements plus one campus. Initial worker preparation measured 2298.9 ms for the unit and 1212.1 ms for campus; source compilation was 1173.6 / 760.7 ms in parallel.

Warm full-site Plan→3D measured 61.1 ms to all-source draw / 75.3 ms to fence; after forced GC it measured 64.4 / 82.4 ms with zero preparation jobs. Focused operating return measured 19 / 36.3 ms with zero jobs. First hall focus took 1078.8 / 1090.2 ms, first operating floor 298.3 / 313.7 ms, and first uncut Stack 906.6 / 929 ms. Warm floor/cutaway returns took 17–19 ms to draw and 30–36 ms to fence. Every Plan transition had zero solid-preparation jobs. First ink took 6.6–55.6 ms; the separate Canvas paint-opportunity milestone took 37.1–315.2 ms and has no GPU-completion claim.

The original 793 Plan failures, CPU profile, Live-off and native-Canvas controls, and two test-only scope-count failures are preserved with hashes. The six valid default-DPR 1 windows from the partial run were kept; only the missing room pair was run afterward. All measured page closures left zero physical worker targets and no runtime exceptions.

[Compact receipt with source hashes, per-window cadence, resource definitions and raw receipt hashes](FINAL-SUPPORTED-NATIVE-R5.json).

Only the owned local QA launcher and its three child services were stopped. Ports 43148/60049/60050/60051 are closed; fixture state and raw evidence remain preserved. No production service was touched.
