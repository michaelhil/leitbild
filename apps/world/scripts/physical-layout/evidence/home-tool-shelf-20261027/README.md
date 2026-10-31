# Native map Home composition: 27 October 2026

This is an untimed functional comparison of built app `20a10558a` with `a1c564464`, using their real Host/World, native map, worker delivery, authored hall-and-annex area, and actual DOM covers. Both are isolated paused loopback Runs with the same retained physical Designs. The candidate server's API process remained at `273c75f90`; only its rebuilt World UI changed afterward. The UI changes do not alter domain code or persisted Run state.

## Cause and result

At a 1280 × 720 host and 280px object rail, the old bottom-right camera bar made the existing magnification scorer select a tall **640px-wide** left rectangle. A wider clear rectangle gave slightly less magnification. This explains the left-biased Home without changing source coordinates, camera bearings, targets, or the fitter's ranking.

The final composition puts navigation beside status in the same top dock, below the full-width primary toolbar. The selected rectangle is **937px wide**. Its preferred-focus screen position moves from x612 to x760.5; fit distance increases 3.484%, a small magnification tradeoff for the wider unobstructed composition. The desktop dock is 95px tall; the original main dock was 74.39px tall and had a separate 58px bottom camera island. The initial side-by-side shelf was rejected because it wrapped primary actions and reached 124–138px.

The snapshot inputs prove unchanged physical bounds, authored focus, bearing, pitch, field of view and projection offset. Four desktop cases have exactly matching final pending-Home and ready-Home inputs. At 390/320px, the longer loading message occupies 15.39px extra real dock height; the pending fit is conservatively larger. Ready Home uses that released space while preserving the same physical intent. This evidence does not claim those two narrow cover rectangles are identical.

The narrow proof also found a pre-existing startup failure: a fixed object drawer left the map auto-placed in a zero-width grid column. The separate drawer CSS fix gives that mode one content column. The retained failure screenshot/DOM contains the actual `container=0x577` diagnostic; the final 320px app opens a 320 × 577px map.

## Actual checks

- 1280px host with 280/360px rails, 1440px host with 280/360px rails, and 390/320px hosts.
- Home requested while Utility routes is genuinely pending, then replayed after coverage is ready.
- All six navigation buttons contained in their dock, at least 44 × 44px; no horizontal document overflow.
- Public close button removes the controls while leaving the geographic map; the real Host **View → Layout controls** restores them.
- Operating Plan has no camera controls. At the matching 1280/280 case its map and tools rectangles are exactly equal to the original app. Native physical source, Plan drawing and fit policy are unchanged.
- All six final receipts have no runtime exceptions. Narrow screenshots establish accessible controls and a functioning viewport, not large-model readability: expanded native attribution and the real controls consume substantial height at 320px.

`summary.json` contains the aggregate and file SHA-256 manifest. Seven JSON receipts preserve the actual loaded minified module hash, finite fit inputs/results, DOM rectangles and public-UI lifecycle results. The images show old/new Home, old/new Plan, final 320px controls and the prior startup failure. `home-before.png` in the raw research folders means the Home reached after the pending request, before the separate ready-Home replay.

## Reproduce

Serve a separately built candidate with an isolated **paused** PWR Run. Use its normal Host URL; the driver rejects non-loopback hosts and never sends playback or operational commands.

```sh
LEITBILD_LOADING_TESTED_COMMIT=a1c564464 \
LEITBILD_HOME_VIEWPORT_WIDTH=1280 \
LEITBILD_HOME_VIEWPORT_HEIGHT=720 \
LEITBILD_HOME_RAIL_WIDTH=280 \
bun apps/world/scripts/physical-layout/native-map-home-composition-probe.ts \
  'http://127.0.0.1:PORT/workspaces/WORKSPACE?world=RUN' OUTPUT_DIRECTORY
```

Repeat with width 1440 and rails 280/360, and widths 390/320. The driver resizes the actual desktop rail using pointer events or uses the real narrow drawer. It drives public scope/floor/layer/Home controls and Header View; no production globals or private map mutations are used. A CDP breakpoint reads the loaded pure fit function's finite metadata and resumes it. It fails closed if it cannot identify that function. **Debugger pauses invalidate all timing claims.** This proof is separate from the independently frozen lease-only rendering/performance A/B.
