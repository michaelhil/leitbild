# Supported opaque native-map UI gate

Tested built source: `793743c00e49d7578544bb4164b9077cde8e01d7`. See the full resolved source reference in `receipt.json`; all UI actions use the isolated paused R5 comparison Run retained there.

The public Host View menu opens Layout controls. The test chooses the admitted turbine-hall/feedwater-annex area, operating floor, 3D and public source Home. The Layout View menu offers no wall/floor opacity inputs or labels. All captures report zero ordered architecture calls and zero BSP jobs.

From fixed Home at 1440×1000, the viewport changes to 1080×800 without camera input. The actual native MVP changes. The test records real Canvas flow-mark translations and the painted annotation bytes, then uses public Live status off/on as an independent recomputation control. The resized MVP is bit-identical before/after that control; annotation dimensions match and **zero bytes differ**, with two genuine flow marks. The suspected stale resize projection is not reproduced in this case. This is one measured case, not a proof that every event ordering is safe.

The public Inspection cutaway toggle is turned off, then on. The screenshots show the closed foreground enclosure and restored open interior. When cutaway is off, no flow annotation is visible and the overlay canvas correctly has zero extent. The final checkbox is checked again, and the source/Run is unchanged. Screenshots and per-action metadata are retained immediately, so a later assertion cannot erase prior evidence.

`rejected-empty-canvas-capture.json` retains the initial test failure: its helper called getImageData on the valid zero-size canvas in the cutaway-off state. The corrected helper handles that absent overlay explicitly. No product code was changed for this test. The first run's resize annotation PNGs were also identical, but the complete accepted run is the receipt and screenshots in this directory.

This is a functional read-only local UI gate. It makes no frame-rate, cold-loading, WAN or other-device claim. Source opacity research support remains below the public UI; it is not presented as a released control.

Reproduce from World, with the separately built source recorded explicitly:

```sh
LEITBILD_LOADING_TESTED_COMMIT=793743c00 \
bun scripts/physical-layout/native-map-resize-probe.ts \
  'http://127.0.0.1:43148/workspaces/a31f9fc6-1961-469c-927c-bb456326dfc1?world=run-94c67255-e555-443c-a9db-4f8e7996dbdf' \
  /absolute/output
```
