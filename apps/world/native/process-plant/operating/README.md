# LD-01 operating equations

This is the standalone Rust equation kernel selected by the approved
[computational review](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Fcomputational-design-review.md).
It is **offline preconstruction work**, not the live PWR Pack, a second runtime,
or a whole-plant simulation. The parent `leitbild-plant-numerics` crate retains
fine-model research evidence; it is not a dependency, fallback or preparation
requirement of this operating kernel.

## Implemented boundary

- Coupled regional kinetics with six delayed-neutron groups, arbitrary explicit
  regional topology and a common extensive population normalization. One
  material-owned precursor bank follows fuel; current emission shares feed the
  regions or explicit outside export. There is no second regional bank.
- Event-fed decay energy reservoirs with separate fission/capture feeds and
  non-overlapping prompt/stored energy budgets.
- I-135/Xe-135 and Pm-149/Sm-149 inventory equations with direct production and
  actual capture coefficients.
- Finite capture targets with shared target-loss, product and binding-energy
  receipts from the same actual exposure, not a fixed ratio to fissions.
- Exact directional derivatives including constitutive input directions.
  A frozen-input derivative is not the complete coupled plant Jacobian.
- Additive fixed-input sparse kinetics Jacobian assembly in linear work, without
  evaluating the whole block once per column. Sum repeated diagonal entries;
  apply constitutive chain rules and the solver's mass shift separately.

Compile immutable coefficients/topology once; evaluate into caller-owned
buffers without stage allocation. Signed finite Newton trials are distinct
from physical admission. Call the accepted-state **and accepted-input**
validators before admitting a converged result; do not clip a negative value
to manufacture success. On any evaluation error, discard the result/output
buffer. Physical mappings, uncertainty domains and error scales remain the
caller/engineering owner's responsibility.

Kinetics inputs include actual material fission conversion, current emission and
outside fractions, regional gain/source and directed coupling. The same actual
fission receipts feed energy and poison inventories. Geometry is not production
physics. The TypeScript source/energy/fluid compilers now consume actual wiki
coefficients, geometry, finite donor/history and caloric/property preparation.
The strict `prepare_hot` binary evaluates that same package through this kernel.
This is quantitative hot-reference preparation, not empirical plant calibration.
The static fuel compiler still does not supply moving topology admission or
pose derivatives.
The [state allocation](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Foperating-equations.md)
counts regional populations plus six histories per material carrier (`R+6A`),
not the first module's replaced `7R` regional inventory. It also records the
uniform two-metre emission approximation and unqualified physical domains.

There are no default plant coefficients, prescribed successful outcomes,
water-property approximation, solver wrapper or live Pack installation here.
Core tests use explicit synthetic equation fixtures; separate opt-in checks
consume the actual owner-generated package. Neither qualifies a connected LD-01.

## Actual hot preparation

The [hot-reference owner](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Foperating-hot-reference.md)
documents the quantitative source, finite 30-day material history, 26 primary
water owners and 2,710 finite solid/helium/SG-metal caloric stores. Maintained
IF97 supplies preparation properties through the existing narrow adapter;
neither the parent fine crate nor its solver/checkpoint is used.

Build explicitly in this directory, then run the composer from the app root:

```sh
cargo build --release --locked --bin prepare_hot
```

```sh
bun apps/world/scripts/reference-design-operating-hot.ts /path/to/Leitbild-wiki /path/to/pinned-IF97 /path/to/operating/target/release/prepare_hot /path/to/private-receipt.json
```

The native boundary uses pinned maintained Serde/JSON decoding once during
preparation, never per stage. It rejects unknown fields, duplicate identities,
invalid finite donors, missing recipients and inconsistent energy/continuity
receipts. The source-off stationary comparator is separate from actual finite
precursor history and external source. A partial pressure check receives only
direct coolant deposition; it does not bypass fuel/clad energy storage.

This binary advances **no simulated time**. Loop mechanics/work, five split
resistances, reciprocal heat laws, PZR/phase transitions, full feedback Jacobian,
stock IDA/KLU integration, real actuation/acquisition and Grid remain joins—not
hidden fixtures, imposed successful outcomes or measured whole-plant throughput.
SG fluid charts are checked by the preparation helper/tests; the native package
currently consumes SG metal, not connected SG fluid evolution.

Native property/package tests are opt-in through `LD01_WIKI_ROOT`,
`LD01_IF97_DIRECTORY` and `LD01_OPERATING_PREPARATION`. Ordinary Bun/application
checks do not require a Rust compiler, property installation or native build.

## Checks

Run from this directory to use the pinned Rust toolchain:

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --all -- --check
bun run tests/build-boundary.ts
```

The build-boundary check examines Cargo's actual dependency graph. Core tests
must work without the parent crate's property backend, private SUNDIALS patch
or fine-model preparation. The next solver join is maintained stock IDA/KLU
through narrow FFI after the bounded compatibility decision, not the previous
fine research driver.

## Progress and change control

The wiki's [batch progress ledger](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Fbuild-readiness.md#approved-plan-and-batch-progress)
is authoritative. Generic equation tests do not establish physical calibration,
hot-spine feasibility, real-time throughput or construction readiness.

Stop dependent work and return to the owner if a finding changes a promised
physical claim, selected state/coupling/solver architecture, or the agreed
feasibility/cost premise. Ordinary implementation defects should be fixed
within this plan. Do not silently reopen a microscopic simulation campaign,
extend an expensive experiment, or count unrelated test passes as plant closure.
