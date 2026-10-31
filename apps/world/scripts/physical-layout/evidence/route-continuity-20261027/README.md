# Native PWR route continuity, 27 October 2026

R5 is an explicit new physical Design revision, using the unchanged admitted
drafting compiler. The old R4 unit and campus sources, admission identities and
exact catalog entries remain available for retained Runs. Three Halden Scenario
Definitions and the layout authoring default select R5 for new Runs.

The source audit found two overlapping generations of utility geometry: the
earlier unbound illustrative preview paths and the later 152 accepted routes
whose endpoints name exact owner graph ports. R5 marks 25 individually
witnessed superseded preview occurrences as removed. Their source identities,
paths and retirement reasons remain retained. Each retirement is guarded by its
accepted graph-bound replacements. Bound header assemblies and the original
brown turbine reheat/admission subassembly remain installed. This is an authored
source correction, without renderer rules about names, colours or unbound pipes.

The original main-steam preview truly terminated above the HP casing, about
1.112 m from its nearest body surface, and bypassed the stop valve. The original
feedwater preview has matching pump/header endpoints; its defect was a duplicate
angular route. Its reported distance to the nearest **equipment** excluded the
pipe header, so that distance must not be described as a floating feedwater end.

`receipt.json` retains the exact old/new Design and compiler identities and the
retirement ledger. All 152 accepted routing definitions/solutions, every graph
correspondence and all 288 owner coverage dispositions remain unchanged. The
unit has 719 visible physical objects instead of 744; each remaining object and
each remaining Plan primitive equals R4 exactly. Campus geometry retains all
540 objects; its source and compiled-shape dependency witnesses and requirements
are re-admitted against R5. A stale R4 witness refuses the new unit.

The portable contact audit checks saved route endpoints against authored
terminal positions, and terminal points against the actual body triangles in
the same source frame. The receipts retain all 239 contacts. All accepted route
endpoints match exactly; 224 contacts lie within the authored 0.01 m mesh
tolerance and 15 are interior taps in closed header solids. There are no
outside-body contacts beyond that authored tolerance. The audit excludes
plinth faces and uses solid-angle winding to distinguish interior header taps.
This does not qualify the illustrative model as surveyed or as built, and it
does not prove route-to-route engineering clearance.

Reproduce from `apps/world`:

```sh
bun scripts/physical-layout/author-pwr-drafting.ts --check
bun scripts/physical-layout/admit-drafting.ts --check
bun scripts/physical-layout/author-pwr-connected.ts --check
bun scripts/physical-layout/admit-connected.ts --check
bun scripts/physical-layout/audit-pwr-route-contacts.ts --source=src/packs/physical-layout/pwr-full-unit-drafting.source.json --output=/tmp/contact-retained.json
bun scripts/physical-layout/audit-pwr-route-contacts.ts --output=/tmp/contact-connected.json
bun test tests/physical-connected.test.ts
```

The source equality guard compares all floors' complete Plan primitive arrays
and complete physical objects, excluding only the explicitly retired previews;
it also verifies unchanged accepted routing, binding and owner coverage arrays,
campus geometry, exact regeneration and stale dependency refusal. Browser
appearance and interaction are separate combined-product acceptance gates.
