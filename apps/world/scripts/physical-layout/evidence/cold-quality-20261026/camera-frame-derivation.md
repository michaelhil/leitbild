# Legacy and native camera-frame audit

Date: 2026-10-27. This audit changes no physical source, Design pin or camera.

The original browser Home camera is defined in `experiments/pwr-layout-3d-browser-trial` and retained in the reference renderer: target `[44.4,11.5,24]`, distance `115`, azimuth `-0.7` radians, elevation `0.56` radians. Its axes are plan X, elevation, plan Y. The retained native source uses plan X, plan Y, elevation. The numerical conversion used in the matched comparison is `[oldX,oldZ,oldY]`, followed by translation by the authored origin `[44.4,26,0]`.

That coordinate permutation has determinant **−1**. It is a reflection, not a proper rigid rotation. The matched fixture deliberately multiplies the original clip matrix by this permutation, so original geometry, converted geometry and restored geometry can be compared under the same image-space transform. This is useful evidence for source detail, material and shading regressions. It does **not** establish that this image is attainable with a proper native camera or that an authored Home pose exactly matches it.

After that permutation, the legacy camera's normalized back direction is approximately `[-0.5462,+0.6480,+0.5312]`, while its screen-right direction is `[+0.7648,+0.6442,0]`. At zero placement bearing, the native east/north/up-to-Mercator transform reflects the north axis. The native camera at bearing `139.893°`, pitch `57.914°` has the same back direction but the **opposite** screen-right direction. This explains the reversed HP/generator ordering in the actual host screenshot without implicating the shared analytic fit.

A proper legacy conversion would instead use `[oldX,-oldZ,oldY]`; its corresponding native Home bearing is approximately `40.107°`. That conversion would reflect the retained unit's plan Y and every related placement, interface and authored context. Changing only the bearing to `40.107°` is a different valid native vantage; it corrects machinery ordering but changes the facade and annex depth, so it must not be called an exact legacy-camera match.

The program decision is to retain the physical source and the current `139.893°` authored native vantage. The current task requires credible architecture and usable inspection, not a silent chirality change. No source normalization or ordering-only camera change is admitted. Actual Map/Canvas UI qualification, with correct surroundings visibility and framing, remains the visual gate. The matched source-only A/B/C captures retain the narrower detail/shading interpretation above.
