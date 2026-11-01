//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The one LD-01 unit library (W2): the composition, its solver profile and
//! the frame-driven unit, shared by the tests, the gate harnesses and the
//! host. Nothing here is a new physics, solver or tolerance rule: it is the
//! composition the S2 declaration's steps (A)-(D) and S3-D28 (3) state, the
//! stock IDA settings the harnesses declared, and IC-PROT's frame driver
//! with its clients, moved out of the test files that held them.
//!
//! - [`inputs`]: the explicit inputs (the compiled packet, the wiki whose
//!   strict blocks the composition reads, the S3 sections), read from the
//!   environment only by [`inputs::Spine::from_env`] and
//!   [`inputs::Inputs::from_env`];
//! - [`profile`]: the solver profile (stock IDA settings, the exact
//!   consistent start's bounds, the preparations' controls, S1's tolerance
//!   classes from `ld01-s1-gates`);
//! - [`spine`]: the S2 composition at the hot reference (steps (A)-(D));
//! - [`s3`]: the S3 composition (S3-D28 (3)) on stock IDA with ELEC's slice;
//! - [`pzr_control`]: IC-CTRL's PZR pressure controller as a frame client;
//! - [`rod_control`]: automatic rod control (X4.4) as a frame client;
//! - [`plant`]: the frame-driven unit (protection, PZR control and field
//!   clients; the Grid stand-in's boundary) the S3 cases and the host drive;
//! - [`timeline`]: a frame-driven run's events on the case clock;
//! - [`clock`], [`provenance`]: receipt support (CPU clocks, app and wiki
//!   provenance).
pub mod clock;
pub mod inputs;
pub mod plant;
pub mod profile;
pub mod provenance;
pub mod pzr_control;
pub mod rod_control;
pub mod s3;
pub mod spine;
pub mod timeline;
pub mod turbine;
