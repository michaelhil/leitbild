# Independent trial and wiki review

24 October 2026. Reviewer: independent verifier, separate from the IFC, native and renderer implementers. Review-only assignment; no contender source, generated contender output, application, wiki or production state was changed. Two in-memory counterexamples expose material defects in the frozen IFC candidate. They concern this implementation, not intrinsic IFC capability.

## Judgment

**Do not qualify IFC candidate `91670729621fecaec85ff0e8a9d99b55b19afbb9` as passing the frozen authoring gate.** Its 26 successful own checks do not cover complete intended-value admission or additional native representation items. TV01 and TV02 below reproduce failures of two mandatory controls. Retaining that failed contender is useful evidence; a repair after the agreed bounded correction stage must not silently relabel this frozen outcome as a pass.

The native candidate's exact-candidate admission rejects the matched same-target, governing-requirement, process-pin and study-applicability mutations inspected here. Native source with declared limited IFC exchange is a defensible preferred direction, conditional on the coordinator's source-derived graphical review and exact final receipt. This is a finite supported profile, not a ready production Pack or arbitrary BIM editor.

Renderer `060879dfb5bf064a19b04e91a5f6d549f8412f5f` supports a native WebGL recommendation for the measured finite opaque-geometry envelope. Both renderers exercise equivalent geometry, shader/view policy and CPU picker, and their measured frame intervals are effectively equal on the named Mac/Chrome profile. Babylon's extra lazy bytes are real, while a reduction in total owned maintenance for this envelope has not been demonstrated. These facts do not establish general native superiority or qualify untested engine capabilities.

The eleven wiki pages are coherent and useful for agents: proposed contracts are visibly distinct from installed behavior, operational and physical identity are separate, current vignette/faceplate interfaces supersede retired mimic advice, and the historical fixture/current production mismatch is explicit. The decision page was still being finalized during this review. Publication must incorporate the actual outcome and these contrary findings, not leave the provisional IFC preference or own-check counts as the recommendation.

## Inputs and checks

- Frozen common brief/fixtures at `c9a8273a29e13e338013c671e06f1fc605fb86f9`; accepted plan SHA256 `ad7f78a7c8601a487d0285628545e4c1cb3efdc927fa1beafdfbab588ffe6ff3`.
- IFC source, reader/writer, editor/admission, fixture/composition, tests, README and final receipts at `91670729621fecaec85ff0e8a9d99b55b19afbb9`.
- Native model/editor/compiler/import/export/harness, README, saved sources and receipts during final correction, subsequently frozen at `8b15e74c2423967f7f90c3ddf76bc6e4349c9f26`. Exact original and final inspected core file hashes are in `independent-probe-receipt.json` and `independent-probe-receipt-final.json`; the core files used for the counterchecks remained byte-identical across freeze.
- Renderer source/controller/state guards/backends/visibility/picking/tests, README, final browser receipt and negative-control evidence at `060879dfb5bf064a19b04e91a5f6d549f8412f5f`. Independently reran nine unit tests: 9 pass, 44 assertions. The reviewer did not rerun the browser benchmark or operate CUA; the coordinator owns independent graphical inspection.
- All eleven `world/physical-layouts` wiki pages. Exact page hashes at inspection are retained in `wiki-review-inputs.json`; later substantive decision edits need bounded closure.
- Executed `independent-probes.ts` against saved source without writing contender files. The actual receipt records source/core hashes, commands' semantic purpose, refusals and IFC accepted mutations. These are hostile-candidate probes, not production or security qualification.
- Independently reran the native full trial into `/tmp/leitbild-native-independent-review-20261024`, leaving the frozen contender output untouched: **65/65 checks**, exit zero, 7.54 s on this run, saved source 44,865 bytes and mesh gzip 326,142 bytes. Summary and exact original receipt hash are retained in `native-independent-rerun.json`. This rerun includes isolated source-only SVG/geometry/compiler-provenance checks. It does not replace the coordinator's visual acceptance.
- Independently reran IFC tests at its frozen commit: six tests, 21 assertions passed. The new counterexamples still fail admission/preservation despite that successful original suite.

## Necessary findings

### TV01 — IFC admission compares affected IDs, not the intended semantic values

**Location:** IFC `edit.ts`, `admit`, especially the `changedElements` versus `c.intended` comparisons before and after serialization. `semanticSnapshot` is keyed only by elements; types, levels and most metadata are not independently compared as a complete candidate.

**Evidence:** With the frozen saved IFC, request `move-pump` east 2 m and inject a second +100 m change to the **same** pump through the existing test mutation hook. Admission accepts it. Pump A moves from `[17,40.4,0]` to `[119,40.4,0]`: 102 m rather than the requested 2 m. The receipt nevertheless reports intended and actual both as `['mfw-a']`.

The existing collateral test changes an unrelated vessel, so its changed-ID-set check detects that easier case. It cannot enforce values within an already authorized changed element or a complete non-element source diff. A successful save/reopen merely preserves the wrong accepted candidate.

**Required disposition:** mark this frozen candidate's full intended/actual admission control failed. A future repair would construct the exact expected candidate and compare all admitted semantic facts/values—including type, level, requirement and metadata scope—before and after native serialization, with same-target and non-element negative controls. Do not weaken the criterion to “only expected IDs changed.” No repair was made in this independent review.

### TV02 — IFC reader accepts additional native shape items then omits them

**Location:** IFC `ifc.ts:108`, loop over product representations: `const rep=get(ref),face=get(rep.Items[0])`. It consumes only the first item and does not reject additional items or prove every supported native representation is accounted for.

**Evidence:** Append an existing wall tessellated-face-set reference as a second item in the first pump's native Body representation, save to bytes in memory and call the ordinary reader. The reader accepts it. Native tessellation changes from 30,277 to 30,397 triangles, while the reconstructed model and the reconstructed pump body remain hash-identical. The additional source geometry is therefore present natively but absent from the admitted model/body used for regeneration. A subsequent normalized write/delivery can discard it without an unsupported/loss diagnostic.

This is a supported-profile cardinality/consumption failure. Correct read-only retention of foreign F4 files does not resolve it: the mutated source still carries this contender's accepted profile and supported entity kinds.

**Required disposition:** mark this frozen candidate's source-admission/preservation control failed. A later narrow profile must reject unexpected item/role cardinality or consume/preserve every supported item, and test native additions that leave authoritative parameters unchanged. Broader arbitrary IFC editing is not required. No rescue change was made here.

## Recommended clarification

### TV03 — State the native IFC exchange support/loss matrix explicitly

**Location:** Native `ifc.ts`, exchange receipt and README; wiki source decision when finalized.

The exporter truthfully declares generated tessellated exchange, stable IDs, provenance, ports and void/fill relations; foreign imports remain separately retained/read-only and merged export is refused. These are useful supported boundaries. Readback currently checks mesh presence and complete AABBs, plus relation counts; that alone is not full shape/topology, semantic or independent exporter validation. It does not reconstruct the native authoring grammar.

For agent use, list which native facts are exported natively, copied as properties, retained only in native source, or deliberately omitted/unsupported. Examples needing explicit treatment are physical types/variants, space adjacency, scoped instance/member relationships and study/configuration/evidence facts. The existing native source remains authoritative, so this is a recommended scope clarification rather than a demand for full IFC round-trip or a generic BIM platform. Do not describe the exchange file as a semantically equivalent replacement for the native source.

## Scope checks and retained strengths

Native admission compares the complete expected candidate, not merely the affected-ID set. The inspected negative probes refuse an extra 100 m change within the intended pump, independent requirement relaxation, operational model-digest change and retaining a current study against an edited source. The native type/variant harness actually applies the A-only variant after the shared-type edit; the IFC harness exercises those edits separately, a narrower observation that must not be retold as the same chained sequence.

F4 preservation does meaningful work in both contenders: raw bytes/hash dependencies are retained and actual native geometry/relationship facts are inspected. Neither pretends to recover unknown construction history. This is preferable to an invisible lossy conversion or dummy boxes. It is not a general hostile-import audit.

F3 source evidence establishes useful scope-qualified identities and shared-site geometry. In IFC, the two-independent-layout check is only distinct constructed scope-key strings, not two fully serialized independent site instances. Its single composed IFC contains two units and one shared yard. Native explicitly derives separate site-instance geometry. Keep that evidence limit visible; no actual cross-Run status/cache behavior was implemented by either source trial.

Renderer receipts preserve a real initial AA-setting error and the later actual style-lifecycle leak, then recheck the final controller using real old buffer/program handles. Depth/stencil/color negative controls are meaningful. The final declared claims are appropriately bounded: one named hardware/browser profile, opaque meshes, one shader path, CPU picking, twenty mount/style cycles and one forced context recovery. There is no claim of PBR/glTF, accelerated picking, full browser/driver memory, cold WAN, constrained devices or production map/deck/input correctness. State capture covers the exercised shader path; it is not a universal proof for future texture/material states.

The wiki retains key architecture distinctions: one authoritative source per physical fact; process/grid state remains owner-controlled; installed/proposed/removed/temporary configuration is distinct from visibility/operating state; member anchors agree with actual owner geography; display separation never changes check geometry; stale/current and baseline/study evidence remain separate; Run publication never silently hot-swaps attachments. It does not install fake operational objects or invent live readings. These should survive outcome edits.

## Publication closure and limits

Close TV01/TV02 for the current decision by explicitly rejecting the frozen IFC contender for adoption and preserving counterevidence, not by asserting the code defects are fixed. Record final native/renderer commits, reviewed visual outcome, local resource limits and the source profile's unsupported IFC scope. Keep G3–G8 and any unexecuted G0/G1/G2 obligations open. The current-production model differs from the frozen source fixture; resolving the same seven subject IDs is not compatibility admission.

After final native/wikidecision freeze, the same reviewer can verify changed documentation and rebind the read-only probe receipt to the exact commit. This does not require another broad research cycle or production implementation. Human/domain acceptance, source-derived visual judgment and deployment verification remain separate from this bounded audit.
