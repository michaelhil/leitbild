# Native R5 production verification

Release `20261028T003411Z-a717593d40-9df8bc304f` activated successfully from clean main `a717593d40e4c9ffb521b6349dc4c8f32d7ffaf1`, with wiki `7b081cf72feb15ec19898e6a44dbf3dc7dda1e8a`. Host, World, Agents, Caddy, local services and public health passed after activation and after the UI checks. This receipt records actual production interactions, not a new timing benchmark.

[Paused Halden PWR sandbox](https://leitbild.app/workspaces/36917815-9034-4dfc-98c2-f884237a9b7b?world=run-df150834-7879-49c2-9af6-024ab2f17a92). It was created through the Host and published World Capabilities, using the exact current `halden-normal-operation` Definition Revision. All four unit layout objects retain Design `95c2f1c11a22e85230f11bd37d1c0c331b8a68e1f23111f1e29baed81beacae9`; shared campus retains `91f901b8c822e9738554b8e9d9bbfdcf679615efa3dfc05f5b51d7f054a92933`. Each object's Design and provenance were checked against its retained Scenario item. Existing Runs were not rewritten.

## Actual public UI checks

| Check | Observed result | Evidence |
|---|---|---|
| Startup | Alarm strip, grid operations and layout controls hidden; header still reports two unacknowledged Grid alarms. This normal-operation Scenario has no briefing. | [Startup](startup.jpg) |
| View | Utility routes checked by default; off/on restored them. Live status and inspection cutaway checked. Layers, floors, labels and dimensions remain; no wall/floor opacity controls. | [Actual controls](view-controls.txt) |
| Native Plan | Operating floor shows the restored machinery drafting, heavy cut walls, grid, dimensions, work hatches, stair and condenser/LP section inset. | [Operating Plan](native-plan-operating.jpg) |
| Native 3D | Operating floor retains contoured casings, ribbed machinery, bearings, MSR vessels, framing, windows, crane and service/access detail. | [Final 3D](native-3d-final.jpg) |
| Component | Clicking an actual 3D LP casing opened the shared Turbine Generator faceplate: fresh readings, ON LINE, 1,162 MW and its declared external connections. | [Card](turbine-faceplate.jpg), [identity/readings](turbine-faceplate.txt) |
| Connection | Exact main-steam pipe card shows From/To ports, medium and fresh `From → To · 1902 kg/s`. | [Card](pipe-faceplate.jpg), [identity/readings](pipe-faceplate.txt) |
| Process display | Activating actual RCP A opened its faceplate. Only its explicit Open detail action navigated to the pump's detail display. | [Process card](process-faceplate.jpg), [AX state](process-faceplate.txt) |
| Camera | Tilt button and an actual Orbit drag changed the geographic camera; captured readout is tilt 49° / heading 62°. Home restored the authored camera. | [Navigation](orbit-navigation.txt) |
| Full site | All four units and campus reached `5 layouts ready · 0 loading · 0 unavailable`; both model families used Stack/all floors. | [Site](whole-site-3d.jpg), [ready state](whole-site-ready.txt) |
| Switchyard | Actual zoom and Pan retained a stable-looking base in the sampled views. These captures are not a continuous flicker-rate measurement. | [Zoom](switchyard-zoom.jpg), [Pan](switchyard-pan.jpg) |

Independent visual and UX reviews found no material blocker in the captured paths. The operating images preserve the accepted original detail class; the default 1280×720 framing, map sidebar and JPEG soften small text and bolts. These stationary images do not independently certify motion, every floor, every connection or device/WAN performance. No viewport override was used.

The sandbox remains paused with the native 3D operating deck visible. Its header's Grid alarms and the Plant's zero owner alerts are different owner-qualified populations. Unit coverage in the JSON counts components **and** connections: 260 represented of 288 owner subjects. Campus coverage includes the much larger regional Grid; unplaced regional subjects are not missing site buildings.

## Release gates and performance boundaries

The unified runner passed platform checks, all required tests and all three UI builds before activation. World: **4,823 pass, 107 existing skips, 0 fail**, 2,279,317 assertions. Agents: **1,788 pass, 9 existing skips, 0 fail**. The separate combined regression/API group passed 80 tests and 1,158 assertions. Source and wiki were clean and pushed before packaging.

The initial full-suite rejection exposed three integration regressions. Readable line states needed compact Energized labels; a newly readable feedwater continuation needed full-size arrow room inside its actual stop cell; repeated exact observation stamps made the process sample too large. The fixes preserve full labels, final glyph geometry and all 132 sample observations. Lossless wire JSON fell from 40,301 to 33,305 characters against the unchanged 39,452.67 budget. A subsequent check caught two new test comparison types; their correction changes no runtime code. No release check was bypassed.

[Supported native R5 qualification](../draw-stack-20261027/supported-final/FINAL-SUPPORTED-NATIVE-R5.md) remains the measured performance authority. Its tested app is `954af6cf2`; native map, physical-layout UI and native layout acquisition paths are unchanged through this deployed release. Later production changes affect process-display arrow drawing, short labels and the separate vignette sample codec.

All 32 measured local motion windows passed at RAF p95 16.7–16.8 ms. Warm whole-site Plan→3D fence completion was 75 ms, or 82 ms after forced GC. **Cold completion remains 5.54 seconds from Host navigation / 3.78 seconds from the full-site action** on that machine. This production smoke adds no new speedup, WAN or universal frame-rate claim. Wall/floor transparency is withheld after failed full-site qualification, as authorized; cutaway and levels remain available, with no hidden opacity clamp or content cap.

[Machine-readable receipt and artifact hashes](receipt.json). AX text files remove trailing horizontal whitespace for repository formatting; the receipt keeps both original and stored hashes. Screenshots are unchanged. The receipt distinguishes the activated release from these later documentation-only files.
