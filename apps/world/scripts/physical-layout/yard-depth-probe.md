# Actual switchyard depth regression

Run `bun scripts/physical-layout/yard-depth-probe.ts` from `apps/world`. A frozen
`apps/world` source checkout can be selected with
`LEITBILD_PHYSICAL_PROBE_SOURCE_ROOT`; `LEITBILD_PHYSICAL_PROBE_DPR=2` starts a
separate actual DPR 2 run. Each run owns its temporary browser and loopback server.

The actual retained campus `yard/gravel` is 300×225 m and only 60 mm thick. Its
top and underside share a material but have different physical normals and
lighting. At wide site scales the former 24-bit perspective depth quantizes
these separated faces together. This is different from exact-coplanar surface
ownership and from the earlier close-up parking-paint control.

The probe uses the real retained campus, real MapLibre and dedicated viewport,
the actual renderer/preparation/picker, site and yard camera scales, and thirteen
nearby pan/zoom/bearing/pitch poses. Fixed model-space top points must be at
least one device pixel inside the projected base. Nine surrounding CPU rays
must all identify the base. Diagnostic white gravel exposes the actual top and
underside lighting; other materials and feature strokes use chromatic colours.
Tracks with chromatic antialias mixtures are excluded as occluder/stroke edges,
and a track must qualify at every pose. Gray top/underside mixtures remain
failures. Both solids-only and normal-stroke configurations run, so a line
overlay cannot explain a separated-solid failure.

The raw receipt retains every observation, qualified point mask, actual uploaded
matrix, pose, pixel, physical pick and depth metadata. Compare exact masks and
matrices before/after; do not count whole-image pixel differences while moving
the camera. The passing result requires more than 200 interior observations per
phase and correct physical top lighting at every qualified point, with zero
winner flips. This is a fixture coverage assertion, not a product count limit.

The correction uses a shared owned 32-bit float depth target and reversed depth
`nearW / clipW`. Original clip coordinates still control XY coverage and near/far
clipping; drawing and picking retain their original matrices. The float target
preserves relative precision far from the camera without physical offsets,
polygon offset, surface removal or source changes. Orthographic/Plan depth is
already linear and reverses its fragment depth. Both hosts use the same maximum
sample count supported jointly by float depth and RGBA8 renderbuffers. The map
layer composites colour only; its local depth never mixes with MapLibre depth.

An owned full-viewport target has a memory/resolve cost, visible in `renderPass`
metrics. Validate moving performance, disposal/state restoration, Plan and
existing unit/parking regressions before release. This probe qualifies the
actual switchyard on the recorded GPU/profile and scales, not arbitrary hardware
or every possible physical gap.
