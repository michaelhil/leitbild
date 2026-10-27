# Rejected float OIT opacity path

The independent GPU oracle ran against production commit `7ebe0176a90da689235c2e5aca22607155bc2db6`, before any ordered architecture pass. The receipt records exact production and fixture SHA256 values. `executed-fixture.js.gz` retains the exact executed browser bundle; `bundle.json` identifies its uncompressed SHA256. Subsequent regression cases extend the active fixture.

Actual Chrome/WebGL2, hardware 4× MSAA, DPR 1 and 2:

- Opaque and hidden architecture have the expected pixels.
- Fractional single-surface interior pixels and order invariance pass, but averaging colours across differently deep surfaces does not equal back-to-front source-over alpha.
- Independently resolving opaque and translucent targets loses sample coverage correlation: 408 DPR1 and 820 DPR2 partially covered silhouette pixels fail the independent opaque-red/opaque-blue average oracle, by up to 24 and 32 RGBA8 units respectively.
- Five opacity changes add no geometry preparation, geometry VBO upload or target resize.
- Independent shared-context checks include texture/sampler unit 2; disposal reports zero owned live GL resources.
- Test-only refusal of `EXT_color_buffer_float` poisons the old renderer: restoring opaque settings cannot resume drawing or picking. This is an injected negative capability, not a claim that the test hardware lacks the extension.

Both failures led to rejection of this architecture. The replacement must blend ordered architecture fragments into the original multisampled colour/depth target and resolve once; no antialiasing downgrade or extra float-colour capability is accepted.

These are functional pixel/resource tests, not performance measurements or whole-product acceptance. The active driver is `scripts/physical-layout/opacity-probe.ts`.
