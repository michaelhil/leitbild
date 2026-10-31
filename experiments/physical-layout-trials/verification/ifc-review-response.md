# IFC contender: response to independent audit

24 October 2026. Frozen candidate: `91670729621fecaec85ff0e8a9d99b55b19afbb9`. This note acknowledges two necessary findings against that candidate. No code, source artifact, original receipt or application file was changed, and no additional rescue round is requested.

**Disposition: the IFC candidate fails the complete intended/actual admission and unsupported-geometry preservation gates.** Its original 26 passing self-checks and six Bun tests are retained evidence of those particular exercised cases, not evidence that these broader contracts hold. My earlier description of “full collateral checks” was too broad: the implementation checked changed-element membership, not complete conformance to intended values.

## TV01 — Authorized element identity does not authorize arbitrary changed values

The auditor reported that a request to move `mfw-a` +2 m east, followed by a +100 m modification to that same candidate element, was admitted. I then independently reproduced it **in memory** against the unchanged frozen candidate:

```json
{
  "requestedDeltaM": 2,
  "beforeXM": 17,
  "expectedAfterXM": 19,
  "actualAfterXM": 119,
  "reportedIntended": ["mfw-a"],
  "reportedActual": ["mfw-a"],
  "admitted": true
}
```

The implementation in `edit.ts` compares the set of IDs returned by `changedElements` with `candidate.intended`. A post-candidate modification to the already named pump leaves those sets equal. Save/reopen then regenerates internally consistent geometry and repeats the same insufficient ID-set check. Geometry consistency and identity preservation therefore coexist with an unintended 102 m displacement.

The original negative control changed an unrelated `fixed-vessel` ID, so it did not cover this case. The `tamper` option is an experimental corruption-injection hook; the defect it exposes is still in the admission contract, which should reject a candidate that deviates from the requested operation. No claim is made that a production World endpoint currently exposes that hook or this experiment.

**Minimal future repair:** retain the canonical expected candidate or exact operation postconditions before accepting a submitted/modified candidate. Compare actual values, effective type parameters, geometry/interfaces/envelopes, metadata and intended dependencies—not only changed IDs—before publication and again after reopening. Use expected-base/revision checks as an additional condition, not as a replacement. Add a same-authorized-element excess-change negative fixture. That repair is future work; it has not been implemented or requalified here.

## TV02 — Extra native representation content can be accepted and omitted

The coordinator supplied the auditor's executed result: append an existing wall tessellated face set as a second item in the first pump's Body representation. The source is accepted, native tessellation triangle count increases **30,277 → 30,397**, while the reconstructed body facts omit the second item. I have statically verified the frozen reader's relevant mechanism, but have **not independently rerun this mutation**: `ifc.ts` reads `get(rep.Items[0])` and neither rejects additional items nor processes them all.

This invalidates the unsupported-content/preservation claim for the admitted custom profile. The separate F4 read-only raw-file preservation checks do not close it. Checking only the first item's body against regenerated family geometry can pass while the accepted IFC carries additional physical content that delivery and semantic change records omit. A native aggregate triangle count is diagnostic evidence, not an enforced loss check.

**Minimal future repair:** either reject every representation whose item cardinality differs from the finite profile's supported cardinality, or process and account for every item with stable role/identity. Also reject duplicate representation roles or unexplained native content, and compare the complete admitted source/delivery representation inventory. Add extra-item, duplicate-role and unsupported-content negative fixtures. This should remain a bounded profile rule; it does not require a universal IFC editor. No repair or new passing outcome is claimed.

## Scope and recommendation consequence

Both findings are **implementation defects in this contender**, not evidence that IFC inherently cannot enforce intended edits or preserve geometry. The trial still demonstrates useful saved-source family regeneration, native relationships and the particular positive operations. It does not establish a production-ready authoring/admission path.

The frozen budget/correction rule should stand. Do not select this IFC implementation as the canonical source path on the basis of its self-check count, file standard or attractive output. Retain the failed outcomes in the source comparison and wiki decision. If a future IFC implementation is reconsidered, these exact cases must be part of a newly authorized and independently checked qualification—not silently patched into this frozen result. The native contender must independently satisfy the same intended-value and preservation obligations.

Evidence boundary: TV01 includes the auditor's supplied proof, my direct source inspection and my independent in-memory reproduction; TV02 includes the auditor's executed numbers supplied by the coordinator and my direct source inspection. No private reasoning transcript, app mutation, new rescue round or human approval is implied by this note.
