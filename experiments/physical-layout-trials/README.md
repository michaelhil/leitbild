# Physical-layout authoring and rendering comparison

Executed 24 October 2026 against the precommitted [matched brief and fixtures](common/brief.md). This directory is reproducible experimental tooling and evidence, not a registered production Pack. Durable architecture, domain specifications and functionality are maintained in the wiki's **World → Physical layouts** section.

## Decision

**Select native typed declarative source for the bounded authoring profile, with IFC as declared-subset exchange and hash-bound read-only foreign source. Select native WebGL2 for the tested finite-geometry map slice.** Neither selection claims production integration, complete BIM interchange, qualified plant engineering, constrained-device performance or whole-campus readiness. No Blender dependency is required.

This changes the earlier provisional IFC/Babylon preference because the matched experiments and adversarial checks supplied contrary evidence. It does not establish that IFC cannot implement correct admission or Babylon is generally slower.

## Authoring evidence

| Question | Native source | IFC source |
|---|---|---|
| Positive/negative selfsuite | 65/65 checks, independently rerun in a separate output directory | 26/26 checks plus 6 tests/21 assertions, independently rerun in an isolated copy |
| Same-target unintended extra move | Rejected | Requested +2 m, same-target tamper admitted +102 m (TV01) |
| Additional native representation geometry | Native closed source rejects an extra editable body recipe; imported IFC is explicitly read-only | An additional Body item was accepted but ignored in reconstructed facts/delivery (TV02) |
| Independent geometry predicates | 13/13: actual rotated wall aperture/controls, preserved opening/lintel, move, roof/deck separation and variants | 13/13 same bounded exported-triangle predicates; does not repair source admission/preservation |
| Saved baseline size | 44,865 B JSON | 1,240,254 B IFC |
| Source-derived build samples | Fresh single build ~248 ms/~170 MB RSS | Fresh isolated rebuild ~1,214 ms; typical edit/save/reopen ~1.5–1.6 s |
| Overall source gate | Suitable selected bounded profile after independent source/visual checks | **Not qualified**: necessary admission/preservation predicates fail despite the selfsuite |

Timing/output sizes are observed local samples of different implementations, not a controlled format-wide speed comparison. Both unoptimized full qualification batches reach roughly 1.4–1.5 GB reported process peaks while constructing repeated meshes and exercising IFC. Do not compare native's single-build memory with IFC's whole-batch peak as equivalent workloads. Both own substantial reusable family and spatial tooling; source line count is not the decision rule.

Native's IFC interface supports the tested geometry/identity/port/void/fill subset. Foreign IFC is retained exactly, hash-bound and inspected for native geometry/facts. It is not reconstructed into an invented family. Arbitrary imported parametric edits, merging foreign raw IFC into one exported file, general CSG/routing and whole-campus engineering are unsupported. Raw-file export remains separate and explicit. See [native profile and receipts](native/README.md).

The IFC author acknowledged TV01/TV02 and withdrew full-admission/preservation qualification. Frozen code/receipts remain intact; no additional rescue round silently qualified the contender. [Independent probes](verification/independent-probes.ts), [final actual counterexamples](verification/independent-probe-receipt-final.json), [review](verification/independent-review.md) and [author response](verification/ifc-review-response.md) preserve the basis.

## Rendering evidence

Both backends use MapLibre6.0.0-11, one shared WebGL2 context/camera, identical geometry and shared CPU triangle-reference picking. Babylon9.23.0 passes the tested shared-context envelope. The shaders/pick policy are equivalent; no Babylon-accelerated picker or advanced material/asset benefit is claimed.

| Workload | Native p95 total frame interval | Babylon p95 |
|---|---|---|
| Accepted 16-equipment slice | 17.8 ms | 17.9 ms |
| 500 repeated shaped assemblies | 18.4 ms | 18.0 ms |
| Four units and shared yard | 18.1 ms | 18.1 ms |

One Apple M2/Chrome155/ANGLE Metal profile at1440×913 DPR1, 90-frame samples. Differences indicate meaningful parity here, not a hardware-fleet ranking. Babylon adds937,491raw JS bytes in the actual lazy path, or226,870bytes if those modules were gzip-served. The server serves raw assets; gzip is an estimate, not measured network transfer.

Both pass actual color/depth/stencil preservation, GL state restoration and no-error checks, pixel-identical correctness frames, visible picking/occlusion, status-only changes without vertex upload,20mount/disposal cycles,20full style replacements and one forced context restore. Deliberate buffer-clearing controls fail as expected. Actual deleted buffers/programs report zero still live. This is owned-resource evidence, not proof of zero total driver/browser memory growth. Idle repaint was zero in the350ms observation window.

The style lifecycle initially leaked in both paths; failed receipts are retained. The shared controller explicitly disposes resources when full style replacement omits `onRemove`. Antialias configuration was corrected and the matched full recheck used actual AA=true. Native wins the tested envelope on parity plus incremental cost and no demonstrated reduction in owned responsibilities from Babylon. Future qualified glTF/material/scene/picking requirements may change that decision. See [renderer report](render/README.md) and [exact final receipt](render/receipts/final-receipt.json).

## Independent visual and model checks

The coordinator inspected both saved-source SVG plans and native source-derived solids in the browser, separately from the reference-geometry renderer benchmark. Corrected native output retains walls/openings, stairs, rooms, shaped machinery and the two-level arrangement; black/missing SVG paint and stale base output were caught and corrected before freeze. IFC also produces a credible bounded drawing, but visual quality cannot override its failed integrity predicates.

This establishes credible source-derived architectural/equipment output within this fixture, not a formal human architectural acceptance or exact publication-quality parity. Labels/plot framing and narrow638px viewer fit need production refinement. Imported view-only wall/roof cutaway is explicitly uncapped and not checking geometry. Arbitrary multilevel imported separation, cold WAN, constrained hardware, full production tile/deck/input/card stack, coherent live status and outage checks remain unqualified.

The frozen process model has116components/156links. Current preserved production has121/167 and a different model digest. All seven bound subjects exist, but the source must be re-admitted against current owner resolution before any live use. [Production baseline](verification/production-baseline.json) records this actual change. No latest substitution is allowed.

## Reproduce and inspect

Each contender has its own package/lockfile and documented commands. Run the IFC trial before its unit tests because generated variant fixtures are deliberately not all committed. Use a disposable copy to avoid replacing frozen receipts. Native supports a separate output argument: `bun run trial /tmp/leitbild-native-independent`. Root's [IFC replay receipt](verification/ifc-positive-replay.json) and [native independent rerun](verification/native-independent-rerun.json) distinguish selfsuite reproduction from qualification.

`verification/check-scenes.ts` independently reads exported triangles with no contender geometry helpers. Its initial variant comparison wrongly assumed both variants started from the baseline; native correctly variants the shared-type result. The corrected check uses each declared operation base, retains the initial receipt and discloses that IFC sequential type→variant is not independently exercised there. No candidate failure is hidden as a harness correction.

The renderer and local-only preview servers can display actual source-derived geometry and plans. Rebuild/copy imports after source changes and retain source/output hashes; copied delivery is not a second editing authority. Source/profile/engine code is deliberately outside production runtime paths. Future G3–G8 integration gates remain work, not passed results.
