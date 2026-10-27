# Native map preparation checkpoint: same final R4 source

This comparison tests built app `17cc50229` against `7aa8370dd` on the same retained paused local Run and exact unit/campus Designs. Both use the original-quality singleton Plan painter and one native geographic map. It is an intermediate preparation checkpoint, preceding startup-menu and layer-demand changes.

| Actual milestone |17cc baseline|7aa candidate|
|---|---:|---:|
|Full-site action → first 3D draw|3311.5 ms|2411.4 ms|
|Action → both source families drawn|4859.5 ms|4151.3 ms|
|Action → subsequent all-family GPU fence completed|4943.6 ms|4180.0 ms|
|Unit preparation response, including queue/transfer|3240.0 ms|2535.4 ms|
|Campus preparation response, including queue/transfer|2190.3 ms|1349.2 ms|
|First scoped operating-floor 3D draw|614.5 ms|381.1 ms|
|GC return to resident operating-floor 3D draw|35.5 ms|35.0 ms|
|GC return to resident operating Plan, actual first ink|8.3 ms|9.7 ms|

The first draw improved 27.2% and complete source-family drawing 14.6% in this one checkpoint pair. The remaining 4.15-second complete cold action is still a material delay; this is not acceptance of the old roughly 2.2-second complete-site target. The unit's source compilation response remains 1273.5 ms and campus 821.7 ms. Four unit placements share one exact source/prepared family. Source registration uses owned transferred numeric buffers; subsequent view jobs carry references rather than clone whole scenes.

Each checkpoint restarted its own local services before a fresh Chrome profile. The two exact Designs are unit `b4458fe4ae078623b6b8f426950b34627a49844ca5fc83f2c2bf970aa1a5da82` and campus `4bc1d405da6a996902a3f799c7af009144fdf617886edfcaed4f72012983cb84`, compiler `738f7a053a2567552490e2c9147d2960a139dd8a8c06a5bfa4b5505d160d51f0`. Unit 744 and campus 540 source objects were admitted in both. Their render buffers remain 29,784,720 and 18,587,088 bytes. The candidate includes the separately validated tangent-cap correction, overlap-specific spatial construction/typed-output optimization, source-adapter optimization and compact controls. This product pair does not isolate the time contribution of one change.

The complete cold milestone requires an actual submitted draw from both required source cohorts—four unit instances plus one campus—before placing a new GPU fence. It is not inferred from a ready label, worker pending 0, or the first visible unit. Plan acceptance uses actual Canvas ink and two subsequent scheduling frames; it does not claim WebGL-fence completion for Canvas.

## Motion and retained resources

All 16 candidate windows (site/room × Plan/3D × paused/playing × DPR1/2) measured 95th-percentile RAF intervals 16.7–16.8 ms on this Mac's actual Chrome profile with 8 reported logical CPUs. Fifteen windows had no long task; DPR2 site Plan playing had one 88 ms long task whose stack was not profiled. No rendering exception, pending preparation, or process window opened by the closed-loop orbit gesture was observed. Both floor-group actions affected all four identical unit placements while leaving campus unchanged.

Actual room Plan calls include 37 caption strings, including HP, LP 1, GEN and TURBINE HALL. New Path2D construction did not occur during motion. At DPR2 the recorded 3D pass uses 4 samples with 60,203,520 bytes each for the depth and color renderbuffers plus 15,050,880 bytes for the resolved texture; the drafting Canvas has a 15,050,880-byte RGBA lower bound. These are allocation inventories, not process RSS or total driver memory. Closing each page left zero physical worker targets.

The same byte-measured residency policy permits eviction. Returning from Plan to operating 3D needed one preparation again (396 ms to draw), while direct GC returns to still-resident 3D/Plan reused the prepared asset. The report does not promise that every visited floor/scope stays resident.

## Interpretation and remaining qualification

The V8 worker profile preceding the change identified overlap spatial queries and index construction as the dominant unit/campus preparation costs; whole geometry construction was smaller. The preparation specialist's separate exact-array proof covers geometry, materials, conditional ownership and picking arrays; independent pixel, cap and Plan raster tests remain necessary quality gates. The actual 17cc grouped-floor failure was preserved and led to the tangent-cap fix rather than being hidden by the performance test.

This is one quiet reference-device pair, not a statistical or constrained-device claim. Large API byte counts were measured on uncompressed loopback; production Caddy already negotiates zstd/gzip, so they do not describe WAN transfer. Upcoming initial-layer demand must be qualified with both default settings and utilities enabled, preserving every requested detail. New startup visibility changes also need their own actual Host/World check and final geometry-loading/motion qualification.

[Compact measurements, raw receipt paths and SHA-256 provenance](./PREPARATION-CHECKPOINT.json) retain the exact readings. No private Run state or source blobs are copied into this evidence.
