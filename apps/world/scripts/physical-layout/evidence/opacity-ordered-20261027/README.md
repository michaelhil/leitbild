# Ordered architecture opacity: independent GPU qualification

The actual renderer files match frozen GPU tree `17eb59924`; the application was at `79cdaf480` during this run. `source-manifest.json` verifies every recorded production-file hash against that frozen tree and identifies the exact committed fixture. The compressed executed browser bundle and its SHA256 are retained.

Actual Chrome/WebGL2 on this machine, DPR 1 and 2, original hardware 4× MSAA. All 14 cases pass at each DPR:

- Hidden, 50% and opaque wall pixels match independent source-over colour expectations; reversing input submission preserves the complete parallel-overlap image.
- All 408 DPR1 and 820 DPR2 partially covered silhouette pixels match the independent average of opaque red/blue references exactly. Maximum error is zero. The rejected float OIT path failed these same edge populations.
- Three intersecting planes and rotated repeated-family placements match independently calculated depth orders. True perspective cyclic overlap preserves the original shader lighting, within one RGBA8 rounding unit.
- Authored ink on a far wall is attenuated before the nearer surface; reversing submission preserves its image. There are 168/332 observed ink pixels.
- A same-scene coarse overview cannot replace the detailed architecture asset. A cohort's first/reference placement can leave current draws without changing the remaining geometry's frame.
- Real retained GL Plan uses its semantic depth bands and exact unlit colour: opaque equipment stays blue above fractional architecture and remains the exact pick target.
- At zero floor opacity, a retained coincident equipment alternative becomes visible and pickable without a VBO upload.
- Five opacity changes add no source-geometry preparation, BSP preparation, geometry VBO upload or target resize after the cohort is warm. Expected owner-table and camera-order updates remain allowed.
- Injecting refusal of `EXT_color_buffer_float` results in zero queries for that extension, working fractional rendering, and working opaque rendering/picking afterward. No extra float-colour capability is required.
- Independent shared-context checks, including texture/sampler unit 2, report no state differences. All tested renderers and targets dispose their owned buffers, programs, textures, framebuffers and renderbuffers to zero.

Run from `apps/world`:

```sh
bun run scripts/physical-layout/opacity-probe.ts
```

For an independently frozen renderer worktree, set `LEITBILD_OPACITY_RENDERER_ROOT` to its absolute `apps/world` directory. The driver records that tree's commit and file hashes; it changes no application state.

This is a functional pixel, picking and resource gate using test-only known geometry. It does not qualify whole-plant appearance, asynchronous controller/worker lifecycle, motion performance, different GPUs or browsers. Those remain separate product gates. Surface alpha is presentation, not physical light transmission.
