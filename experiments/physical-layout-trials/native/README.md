# Native declarative authoring contender

This isolated experiment implements the native-source side of the frozen matched brief in `../common/brief.md`. It is not a production Pack or an engineered plant. No root/application dependency changed.

## Reproduce

Use Bun 1.4.0 in this directory:

```sh
bun install --frozen-lockfile
bun run check
bun run trial
```

For independent rechecking without overwriting frozen evidence, pass a separate destination: `bun run trial /tmp/leitbild-native-independent`. The common inputs remain read only; generated results go to that destination.

The complete trial creates source bundles, regenerates plan/mesh derivatives, exercises the edits and negative controls, exports/reopens IFC, inspects the held import corpus and repeats the build in a fresh compiler tree without the original fixture/bootstrap. It writes `output/receipt.json`. All 65 automated checks must pass for a successful command, including fresh-process SVG and compiler-provenance comparisons. Source-derived visual acceptance is a separate independent review; the script does not claim it.

To rebuild a saved source independently:

```sh
bun run build.ts output/base/source.json output/rebuilt
```

`model.ts` defines the strict finite profile and field/reference validation. `edit.ts` defines semantic operations, exact-base admission and complete expected/actual keyed diffs. `compile.ts` produces architectural plans, real voided walls/slabs, shaped family meshes, physical interfaces, illustrative task envelopes and scoped composition. `family-plan.ts`, `family-solid.ts`, `mesh.ts` and `math.ts` adapt reusable MIT tooling from the earlier accepted visual trial; their ownership/code cost is counted. The fixed template sizes normalize generic family parameters, not plant placements.

`bootstrap.ts` imports the frozen brief once to author the initial JSON. It is excluded from source-only rebuilding. Every placement, type selection, dimensional parameter, wall/opening/fill, site/shared scope, level, circuit/support relationship, constraint and source dependency needed for the next edit resides in the saved JSON. There is no second editable coordinate recipe or executable per-plant generator in the rebuild path. Saved plan/mesh/IFC are derivatives. Family code is a retained compiler dependency.

## IFC boundary

The only build dependency is `web-ifc@0.0.78` JS/WASM, used for actual imported geometry inspection and native IFC exchange. It is not a browser/runtime requirement for ordinary native-source delivery, and its code/resource cost is not treated as free.

Held IFC imports are exact raw-owned read-only dependencies in the source bundle, hash-bound and re-tessellated in the fresh process. The receipt lists native entity/port/opening/relationship counts and actual mesh hashes. No native-converted entities or recovered construction history are claimed. Unknown/native-unsupported entities retain their original raw bytes and native tessellated geometry; edits through the native grammar are unavailable.

Constructed native geometry exports as actual IFC4X3_ADD2 tessellated machinery/architecture with stable GlobalIds, source provenance, physical ports, void/fill relations and site containment. Readback checks identity and full mesh bounds. The same `web-ifc` library writes and reads, so this is not independent exporter validation or general IFC conformance certification. Merging retained arbitrary raw imports into one generated IFC is explicitly unsupported and refused; export the exact retained raw files separately. No loss is silently accepted.

## Evidence and limits

The initial complete receipt had three false negatives because the instrumentation looked up uppercase IFC type names while the library returns CamelCase. `receipt-initial.json` is retained. Independent browser review also found a stale base plan: the initial trial rebuilt edits/fresh-process output but not base delivery, leaving floor slabs above machinery. After that fix, review found missing no-fill paint classes/pattern definitions causing black symbol patches. One correction stage fixed counters, baseline regeneration, painter order and complete reusable family paint definitions; the complete recheck is `receipt.json`. Development corrected the documented native tessellation Y-up→IFC Z-up adapter before the initial full run. The source's double-leaf doors are one filling assembly with distinct parts, so IFC export does not create multiple fillings for one opening.

The full qualification script repeatedly constructs and serializes large array meshes and retains edit/IFC evidence; its peak process memory is recorded and exceeds a gigabyte on the observed run. It is not a browser renderer measurement or a representative single-build memory claim. `build-receipt.json` and fresh single-process builds report their own memory separately. The implementation is a correctness/authoring spike, not a production-optimized compiler; typed binary/chunked delivery and allocation work remain necessary before production scale.

The automated checks cover actual source-derived body changes, rotated host void/fill/adjacency, roof/deck scope, genuine shared-type and A-only family regeneration, interfaces/envelopes, unrelated collateral detection, old IDs, scoped shared/independent instances, raw-import fidelity and fresh-process derivation. They do not establish architectural visual parity, safe access/removal, real-plant dimensions, complete nuclear campus coverage, renderer performance or human usability.

The profile refuses arbitrary code/body recipes, unknown source fields and unsupported dependencies. This is not a general CAD/constraint/routing system. Live Run state and simulation parameters are not stored or changed. Current model/binding pins are admitted for the bounded source experiment; actual production owner providers remain the separately planned integration work.

Large reproducible JSON derivatives are ignored locally; retained source/receipts and compressed mesh/export evidence are committed explicitly. Inflate `retained-geometry.json.gz` to inspect the same mesh schema used by the rendering comparison. SVG plans and canonical source can be read without running a server.
