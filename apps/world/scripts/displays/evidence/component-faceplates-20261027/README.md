# Direct component faceplates

This untimed browser proof uses the built UI at `a3eabf8c2`, an isolated paused local Run, and its real Host/World, Process Plant and Grid read models. API/domain code was unchanged from base `9c07207dd`; no operational command, acknowledgement, proposal, playback or production write was sent.

The source-bound run exercises fourteen public UI steps. Actual pointer and keyboard events open the same current PWR faceplate from its symbol, text, Enter and Space; Esc closes it and returns focus. A group opens its own card, whose member link opens the member's card with its real Pack controls loaded. Single continuation labels inspect their exact target; plural continuations use the real chooser. Neither card path advances Overview. The explicit **Open detail** action alone opens the turbine-focused display.

The Grid case uses the real display chooser, a multi-target electrical continuation and an explicitly chosen branch. Pointer and keyboard selection open the same branch faceplate with real state, power and loading readings; the card's explicit detail action opens the branch-focused display. Native `aria-expanded` reflects the chooser as well as the current card. The browser recorded no runtime exceptions.

`summary.json` contains the checks and file hashes. `receipt.json` retains the original/current iframe sources, exact inspected element IDs, public display choices, loaded module URLs and card text. The four PNGs show PWR and Grid cards and their explicit deeper displays.

The new single-card `ElementFaceplate` host reuses the existing Faceplate UI and lead-read session; Grid has no new pin framework. Existing Flow monitoring pins stay in place. Callers supply complete owner alerts (the topology/layout read contracts do), exact Run/owner/Pack/element identity, actual available room, and optionally context, width and sizing callbacks. A current-value-only map child uses `showHistory=false`; the client test verifies that this makes no record requests on open, polling or after a hidden gap. Native map child-host adoption is qualified separately by the parent task.

Numeric value rows remain read-only. Named values headings inspect only where one exact owner is identified and the current drawing has registered a card; no owner or Pack is inferred from names. Components with no declared target remain plain. Real command controls were checked for presence and identity, not actuated.

Reproduce against a separately built app and a copied paused Halden Run:

```sh
LEITBILD_FACEPLATE_GRID=1 LEITBILD_LOADING_TESTED_COMMIT=a3eabf8c2 \
bun apps/world/scripts/displays/component-faceplate-probe.ts \
  'http://127.0.0.1:PORT/workspaces/WORKSPACE?world=RUN' OUTPUT_DIRECTORY
```

The driver refuses non-loopback hosts. It uses normal rail/display choices, native pointer events, native Enter/Space character events, actual settled target bounds and the existing commands/card UI; it adds no product globals or hooks. This is functional evidence, not timing or cross-device qualification.
