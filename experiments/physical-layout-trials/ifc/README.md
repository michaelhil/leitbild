# IFC authoring contender

**Post-review qualification: failed.** The frozen positive selfsuite below passes, but independent probes found TV01 (same-target unintended value changes admitted) and TV02 (extra native representation content accepted but omitted). The author acknowledged both. This contender is not selected or qualified for production admission/preservation. See the [coordinator outcome](../README.md), [actual probes](../verification/independent-probe-receipt-final.json) and [author response](../verification/ifc-review-response.md). Source code and original receipts remain frozen; these are implementation defects, not intrinsic IFC limitations.

This is an executed, finite IFC4X3_ADD2 authoring experiment against the frozen [matched brief](../common/brief.md), not a World Pack or a generic CAD editor. The saved IFC is the physical source. Reusable TypeScript family code interprets its admitted profile; no second per-plant JSON recipe is used after the first authoring step. Blender is not used.

## Reproduce

Use Bun 1.4.0. From this directory:

```sh
bun install --frozen-lockfile
bun run trial
bun test
bun run rebuild output/source.ifc output/rebuilt-independently
```

The full trial regenerates heavy variant outputs that are intentionally not all committed. It retains the baseline IFC, plan SVGs, scene/read-model, detailed receipts and compact per-edit diffs. The fresh-process check copies only `model.ts`, `ifc.ts`, `delivery.ts`, `rebuild.ts` and the saved IFC into an isolated tool directory: `fixture.ts` and the original JSON are absent. `web-ifc` remains an ordinary declared tooling dependency. The generated scene hash must match the normal saved-source build.

## Authority contract

| Fact | Normative source | Checked derivative / relation |
|---|---|---|
| Occurrence identity | IFC GlobalId plus profile SourceId | Delivery/pick names derive from it; Express row numbers are not identities. |
| Position and yaw | Native `IfcLocalPlacement` hierarchy | Model/scene world coordinates. Opening placements are native children of their wall; doors are children of openings. |
| Family dimensions | `LeitbildAuthoring` properties on native physical types | Native tessellated bodies are regenerated and checked on every admitted reopen. |
| Occurrence variant | Explicit `Parameter.*` occurrence properties | Variant body, pump nozzles and envelopes; unrelated type instances preserve identity and geometry. |
| Containment | Native spatial containment | LevelId is checked against the native relation; outdoor yard/support/transformer are directly Site-contained. |
| Aperture and filling | Native opening, void and fills relations, native placements and admitted dimensions | Wall/slab native TFS is physically cut; source space adjacency is also represented/checked through native space boundaries. |
| Pump interfaces | Derived from admitted family dimensions | Native `IfcDistributionPort` placement, direction and host nesting are validated, not just copied into a sidecar. |
| Service/removal allowance | Admitted family parameters and finite generation rule | Separately named native checking/display representations. Illustrative allowances, not OEM/task qualification. |
| Process identity | Explicit member, owner and component reference | No simulation parameter or process graph change; no simulated live data in this experiment. |

`ifc.ts` rejects unsupported entity/profile/property/representation kinds, duplicate IDs/property sets, conflicting body parameters, wrong classification, port mismatch, spatial-container mismatch and unsupported geometry. That is a deliberately narrow admission boundary, not arbitrary IFC preservation/editing support. F4 files outside this profile remain raw read-only IFC with declared editability; there is no lossy conversion into placeholder boxes.

The family profile includes shaped horizontal pump/motor and turbine casings, generator, MSR, valve, condenser, simple architecture, multi-flight stairs and utility routes. Many architectural/equipment classes use their native IFC class; some compound casing/structure families use a generic proxy with explicit family identity. This does not claim a complete nuclear equipment classification or independent editable identities for every bolt, motor rib or casing subpart.

## Executed result

Latest local full recheck: **26 passed, zero failed**. Six Bun tests add **21 assertions**, zero failures. The machine is macOS arm64 with Bun 1.4.0; timings are single local samples under concurrent work, not service SLOs or format-wide superiority.

| Work | Latest observation |
|---|---|
| Saved baseline IFC | 1,240,254 bytes; 248,005 bytes gzip |
| Source-derived mesh scene | 959,211 bytes; 194,620 bytes gzip |
| First author/save, including native initialization | 1,130 ms |
| Reopen, profile/body/relation checks and native tessellation | 257 ms |
| Saved-source baseline delivery | 245 ms |
| Door/roof/deck/type/variant/move candidate save + reopen checks | About 1,494–1,618 ms each |
| Fresh isolated-process rebuild | 1,214 ms |
| Whole full-gate run | 18.46 s |
| Reported peak process RSS | 1,480,998,912 bytes; a real unresolved offline-tool resource cost |
| Maintained experiment TypeScript | About 70 KB across family/geometry, IFC reader/writer, admission, plan/delivery, harness and tests; code size alone is not a selection criterion |

`web-ifc 0.0.78` is JS/WASM, MPL-2.0. Its installed Node API file is about 5.7 MB and selected Node WASM about 1.5 MB. It is an offline authoring/build dependency here, **not** a new browser or production dependency. Reusing one API per offline worker improved elapsed time but did **not** demonstrate lower peak RSS; both receipts are retained. No memory-budget pass is claimed.

### What the positive checks establish

- F1 retains all 16 equipment occurrences and seven current operational subjects, native levels/space/container relations and genuinely shaped machinery.
- A new door in the 30° wall has native opening/void/filling/space-boundary relationships. A ray through the aperture centre hits no native wall triangles; the adjacent wall still obstructs it. The existing opening and unrelated source facts remain unchanged.
- Roof-only editing leaves deck, pump and fixed vessel datums unchanged. The separate deck edit changes exactly the named deck, landing, stair, riser and support dependency set.
- Type-wide pump length changes both feedwater pumps, geometry, native nozzles and allowance envelopes. An A-only variant leaves B's body byte-equivalent. Moving the assembly moves its physical interfaces, without changing graph parameters.
- Two unit copies have distinct qualified physical IDs/member/owner references, and the directly Site-contained yard/transformer/first support appear once. Two circuits share that support. Independent site-scope key strings differ. This is source identity proof; actual cross-Run status/cache behavior is not implemented or claimed.
- The original selfsuite checks changed-element membership and unchanged GlobalIds after save/reopen. It refuses its tested unrelated-element changes, but TV01 shows that this does **not** validate exact intended values within an already changed target. TV02 also invalidates the broader preservation claim. Other tested stale-base/model/study, dependency, height and parameter/body refusals remain bounded observations. Old source bytes remain readable.

### F4 preservation evidence

Each corpus file is retained verbatim/read-only, then re-inspected. The inspection inventories actual native entity types and object/port/opening/aspect/void/fill facts, plus native tessellation triangle counts, bounds and mesh-fact hashes. The baseline and rigid-edited import each have 12 native meshes/568 triangles; their mesh hashes differ, capturing the actual placement edit. The unsupported-content case has 13 meshes/604 triangles, retained rather than replaced. `import-receipt.json` contains full counts/hashes and explicit editability.

The edit adapter refuses all three foreign profiles. This is a valid preservation/read-only boundary, **not** a claim that arbitrary imported IFC can be parametrically edited or reconstructed. Native web-ifc tessellation bounds use its native delivery convention; the authored trial's scene itself is explicitly metres/Z-up.

### Correction record

An early harness attempt crashed while hashing the absent side of an add-element diff. The first complete receipt then recorded three failures because the harness expected a later unsupported-profile error name while the parser correctly refused an earlier unsupported property-set kind. The correction phase fixed missing-side hashing and accepted the documented unsupported refusal classes, without dropping the must-pass. It also tightened the finite source profile and retained the original receipts. The full unchanged fixture suite was rerun. A subsequent observed resource concern prompted one-API worker ownership and a full recheck; elapsed time improved but RSS remained high. That failed resource-improvement hypothesis is disclosed rather than promoted as success.

## Qualification and decision limits

The **independent browser visual/style comparison remains for the coordinator**. Passing source/body checks or producing SVGs does not establish parity with the accepted architectural illustration. No production Pack integration, real Run telemetry, human usability, arbitrary IFC editing, topology-different plant integration or outage feasibility has been tested here. File headers have write timestamps; byte identity of repeated writes is not the semantic model digest. Saved-source rebuild identity, intended semantic changes and native GlobalIds are what this trial checks.

The result shows IFC can carry a workable saved parametric source for the bounded edits. It also shows that this route still owns a custom family grammar, plan engine, strict reader/writer, derivative-consistency checks and substantial native-tool resource cost. IFC semantics/interchange are useful; they did not eliminate that application machinery. Select against the native contender only after shared visual acceptance and whole-path burden review, not because the IFC file is a standard or this suite passed.
