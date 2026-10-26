# Delayed inspection content: manual browser proof

This development fixture loads the candidate's real built `Inspection.svelte` and vignette Faceplate in a same-origin iframe. It provides host space immediately but waits for an explicit button before acquiring and delivering the first owner sample. No World/Host stack, model provider, new Run, playback command or equipment command is started.

Build the candidate World UI, then run:

```sh
bun --no-env-file run apps/world/scripts/physical-layout/inspection-sizing-fixture.ts /path/to/config.json --repository /path/to/candidate
```

The server binds an automatically allocated loopback port and prints its URL. Open that URL in the browser. The config is a strict object containing `origin` (HTTPS or local loopback), `workspaceId`, `expected` (the exact `layoutLiveExpectedSchema` scope), `elementId` and `label`. Use an already loaded, already paused Run; the fixture refuses unpaused responses and does not load or resume a Run. An unavailable read is an explicit error, not a fabricated sample or a retry loop.

1. Wait for the initial loading/header-only content to settle. The visible receipt reports ready, intrinsic height, allocated height and the independent available space. No owner read occurs yet.
2. Click **Deliver first owner sample**. It performs one actual read through the existing layout display route, validates scope/owner/schema and forwards only the selected subject. Its receipt timestamp is the actual completed acquisition time. The button is disabled after success; resize messages never refresh that timestamp.
3. Verify that actual readouts become visible and the allocated card grows beyond its earlier loading height, within the available room.
4. Click **Shrink available height**, then **Grow available height**. These change the host room independently of the measured iframe height. Verify that the card recovers when space returns. Values can become correctly labelled stale during a long manual test; do not interpret resizing as fresh acquisition.
5. Inspect browser errors for a wrongly rejected hosted sample. Preserve screenshots, visible receipt and the tested source revision. The fixture reports its candidate Git HEAD but cannot establish that a stale `dist` directory was built from it; build before running.

The parent uses the same validated inspection message/space helpers. Unknown channels are unrelated to this fixture; actual source/origin, scope and ready-channel checks remain enforced. The child and its content sizing are production code. The parent is deliberately a protocol harness, not the actual explorer, so this proof complements actual map/browser Quick look tests rather than replacing them.
