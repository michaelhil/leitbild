//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#coordinated-computation-without-a-new-framework
//! TEST-ONLY S5 risk spike of the World <-> native boundary (PLATFORM lane,
//! LD-01 resume programme, S2-D10/S2-D15). One LD-01 S1 unit advanced in
//! caller-driven time behind a narrow surface, for measurement. It is never
//! registered in a Pack, the Runtime Hub or the deployer, and it adds no
//! physics, solver option or fallback.
pub mod cpu;
pub mod sha256;
pub mod unit;
