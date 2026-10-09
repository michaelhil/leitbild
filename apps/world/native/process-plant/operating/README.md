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
physics. The separate TypeScript static fuel-intersection compiler does not yet
supply moving topology admission, pose derivatives or a calibrated hot operator.
The [state allocation](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Foperating-equations.md)
counts regional populations plus six histories per material carrier (`R+6A`),
not the first module's replaced `7R` regional inventory. It also records the
uniform two-metre emission approximation and unqualified physical domains.

There are no default plant coefficients, prescribed successful outcomes,
water-property approximation, solver wrapper or live Pack installation here.
The tests use explicit synthetic equation fixtures, not a qualified LD-01.

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
