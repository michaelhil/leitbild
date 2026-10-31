# Matched physical illustration comparison

Run `bun scripts/physical-layout/visual-comparison-probe.ts` from `apps/world`.
An isolated loopback server and Chrome profile close in `finally`. The retained
Scenario compiler provides the actual current Unit1 source; no production API
or user's browser is used. Renderer/source commits and relevant file hashes
accompany the captures.

Three views isolate causes. A uses the frozen initial standalone renderer and
original reference scene. B converts that exact selected geometry from Y-up to
Z-up, mapping its exact RGB values back to the original material roles, then
runs real production preparation and rendering. C uses the current admitted
source's declared `area/turbine-island` membership and default layers through
the production pipeline. The fixture uses known source identities as test
inputs; no PWR identities or coordinates are added to the generic renderer.

Both-floor and operating variants share the original perspective camera,
1280×900 viewport and day materials. Utilities, outage overlays and live tint
are off; one separately labelled synthetic alarm-tint frame demonstrates
shape under status. Ground context is omitted equally. A uses the original
engine, including its historical implementation; none of its polygon offsets,
DPR cap or direct picking target are adopted by production.

The copied original renderer changes import paths only. The reference scene's
optional `componentId` type accepts explicit undefined for strict project
checking; emitted geometry is unchanged. The original scene/mesh provenance and
camera recipe are retained. The production comparison injects a controlled
camera matrix to isolate drawing from host fit; it is not a substitute for the
separate actual Map/Canvas camera and full-product tests. No arbitrary image
similarity score constitutes visual acceptance.
