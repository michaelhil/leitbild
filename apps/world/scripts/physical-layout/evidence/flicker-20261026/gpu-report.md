# Exact-final GPU qualification: 95c16392d

The final production correction passes both independent temporal GPU controls. These are new executed receipts from final `95c16392d7865d96b85b02f3d434f011d82fe33e`; earlier `fa3ae431b` receipts remain unchanged in their original folders and are not relabelled as final-source evidence.

The isolated proof checkout is `2283a0783` (the cherry-pick of final 95c onto the proof branch). Its entire `apps/world/src` Git tree is equal to both final 95c and the root integrated release `24e5c3688`. `production-source-manifest.json` records full commit IDs, the equal source-tree IDs and SHA256/byte length of every physical-scene TypeScript source plus both probe runners/apps. `manifest.json` hashes every retained receipt, summary, comparison, source manifest, report and selected screenshot. No further source or test edits were needed for this rerun.

## New executed result

| Control | Actual DPR | Phases | Samples | Correct GPU material / exact CPU target | Unstable tracks | GL/renderer errors |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Turbine hall + Plan | 1 | 12 | 7,634 | 7,634 / 7,634 | 0 | 0 |
| Turbine hall + Plan | 2 | 12 | 7,634 | 7,634 / 7,634 | 0 | 0 |
| Real-gap parking paint | 1 | 4 | 220 | 220 / 220 | 0 | 0 |
| Real-gap parking paint | 2 | 4 | 220 | 220 / 220 | 0 | 0 |

The primary control uses both real MapLibre and dedicated canvas viewports, full Stack/all-floors turbine hall, two room scales, eleven nearby poses, solids-only versus normal feature strokes, and the Plan machinery control. Every 3D phase preserves all 77 exposed-column positive-control samples above the actual wall cut. All 77 Plan machinery paint/pick samples per phase remain correct. Below-cut front wall/column samples resolve to the existing first-source display owner consistently. The source scene digest is still `93a419a84d3f64bc1ecd9503433d6740876c80ce50c2e41a5dfb1448c5449e9e`.

The real-gap control uses the actual campus marking/pavement pair (12 mm bottom gap / 30 mm top separation), one zoom step back from the occurrence fit, five fixed top-face points over eleven nearby poses, both viewports and both feature-stroke configurations. Its minimum full device-pixel interior margins remain 1.200 map / 1.883 canvas at DPR 1 and 3.098 map / 4.260 canvas at DPR 2. The source scene digest is still `194eec67e761e41868afbc2d8e3695f7be1ec3df988a820b3255aa5c23bab200`.

Every before/final uploaded camera matrix is byte-for-byte identical at the corresponding DPR, phase and pose in both controls. Source fixture digests are equal. The primary baseline fails at both DPRs; the final candidate passes. The genuinely separated paint control passes both before and after, reproducing no separate precision fault at this tested readable scale. The final preparation optimization can change contact-only tessellation; we do not claim its prepared geometry is byte-identical to fa3. The source equality and measured final GPU results above are the qualification.

## Provenance and limits

`primary-dpr{1,2}.raw.json` and `real-gap-dpr{1,2}.raw.json` retain the actual raw measurement values; their compact summaries preserve per-point tracks and camera matrices while reducing repeated ownership pair diagnostics. `comparison.json` points to the original baseline receipts and records source-fixture and matrix equality checks. Selected real screenshots are preserved alongside the JSON. The original method, source oracle, antialias edge exclusion and limits are described in the parent report and `real-gap-control/report.md`.

This remains a bounded single-placement PWR/campus proof on Apple M2 / ANGLE Metal / Headless Chrome 156 at two actual DPRs. It does not qualify arbitrary smaller physical gaps, cross-placement overlap, arbitrary authored models, live-status workflows, full-product performance or all GPUs. Those remain separate product/lifecycle/visual acceptance work. No production Run, user browser or deployment was changed. All isolated probe Chrome processes and loopback servers stopped before root resumed product timings.
