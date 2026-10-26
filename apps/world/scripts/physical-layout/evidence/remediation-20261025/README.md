# Executed physical-layout remediation evidence

These are real observations on one Apple M2/Chrome 156 reference profile, not universal performance promises. The current rationale and qualification boundaries live in the wiki's `world/physical-layouts/remediation.md`.

- `renderer-resource-phase.json` and its compact summary retain the earlier five-placement resource/GC proof under its actual pre-transfer source. Its large diagnostic geometry JSON was parsed before its cold timer; it is not product transport evidence.
- `product-before-transfer.json` records the complete app before the typed transport correction. Its 111 ms first map-motion task was traced to boxed scene serialization. It is a failed steady-movement gate, not the final result.
- `product-transfer-phase.json` records the six-window transfer correction at `9128da697`: actual Host/World/PMTiles/observations, 16.7–16.8 ms moving p95 and no moving long tasks. Initial Run/bootstrap tasks remain.
- `product-final.json` records the portable nine-window complete-product probe at `b7fbf04e3`, including Plan panning in both hosts. Every moving p95 is 16.7–16.8 ms; no moving long tasks or JavaScript exceptions occurred. The observer does not attribute all bootstrap costs or establish WAN/device budgets.
- `orbit-gesture.json` verifies closed-loop drag suppression and preservation of ordinary clicks/native gestures.
- `plan-summary.json`, `plan-gl-final.json` and `plan-parking-final.json` retain committed-source hashes, shared-context/lifecycle/negative controls, and eight host/mode/theme parking cases. Base geometry and viewport-sized Plan targets are reported separately.
- `product-ui-phase.json` preserves the actual earlier UI findings and corrected capture/cancel trace. Its earlier blank Plan-parking observation is superseded by the final Plan receipt, not erased.
- `inspection-delayed-content.json` records the later actual real-embed browser proof at `c96432d9e`: the first owner sample is withheld until the header has settled, then the card grows; shrink/grow recovers without another read or a renewed stamp. Its parent is a protocol harness, so actual explorer integration remains a separate smoke check.
- `weather-public-readonly-latency.json` and `weather-public-readonly-comparison.json` preserve bounded sequential public queries. They do not establish the cause of intermittent transport warnings or prove that the viewport-demand fix removes those warnings.
- `hashes.json` hashes these retained JSON files. It does not replace their recorded source/profile/workload identities.

The independent local Run used the current normal-operation Scenario and real Process Plant/Grid observations. Its production map/reference assets were fetched through a read-only HTTPS proxy. It was not the user's production Run. Outer desktop viewport was 1440×913, with 1440×871 World below the Host; narrow was 319×827 outer/319×732 World. Simulation was restored to paused. RAF intervals include browser scheduling; they are not GPU execution time.

Run the full-product probe from the repository root after building the UI and starting a genuinely isolated local stack with map assets:

```sh
bun --no-env-file run apps/world/scripts/physical-layout/product-browser-probe.ts /path/to/qa-run.json /path/to/evidence
```

The input identifies an existing local normal-operation Run through `url`, `workspaceId`, `runId` and its World `resource` reference. The probe refuses non-loopback origins, uses a private Chrome profile, exercises real controls and paused/playing observations, retains screenshots/receipts and closes its browser. It changes playback and restores paused; do not point it at a Run in active use. `QA_TRACE_MAP=1` adds a separate CPU trace whose profiler startup overhead must not be presented as ordinary frame timing.

For isolated engine/resource and Plan correctness, use `retained-host-probe.ts`, `browser-probe.ts` and `plan-parking-probe.ts` beside this evidence directory. Those receipts cannot substitute for complete-product tests. The historical comparison images and raw trace remain in the owner's research workspace; no private agent deliberation transcripts are published here.
