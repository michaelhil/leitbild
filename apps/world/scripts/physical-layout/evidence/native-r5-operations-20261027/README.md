# Actual native R5 operations proof

Functional Host/World browser proof on the isolated paused R5 Run, built from
`a4a2bf1e4`. `receipt.json` records its full commit, exact source Design,
physical model digest, source coordinate frame, prepared geometry keys, selected
floor/scope and actual submitted native MVP/Plan ink transforms. This is not a
frame-time, cold-load, transparency or whole-plant visual-quality benchmark.

Both native 3D and Plan passed through real pointer events:

- Utility routes was checked before any layer toggle.
- The exact physical steam-header-to-stop-valve route was hovered and highlighted.
  Its label showed actual endpoints/ports, medium and acquired signed mass flow.
- A direct physical click opened the exact graph edge and owner faceplate.
- Resting on the route opened that same card after the two-second hover intent;
  a pre-expiry check verified it had not opened early. The elapsed measurements
  start after label acquisition, so they are functional witnesses, not timer
  calibration. The pure hover-intent tests own the exact scheduling contract.
- Hosted samples carried exact R5 revision `95c2f1c1…`, owner `plant:halden-1`,
  actual 1902 kg/s and exact `outletA` → `inlet` endpoint context.

The final phase selected the **Pressurizer body** through an exact pointer hit,
opened its card and used its public PORV device action. The resulting faceplate
was `pressurizer.reliefValve`. It issued its own exact owner/child values lead
and sample requests for position, flow monitor, state, pressure and tailpipe
temperature. Parent housing values were not substituted for the device.

The screenshots show real product pixels. Root separately reviewed the route
and card images; full-hall original-reference visual acceptance remains a
separate gate. The retained failed harness receipt documents an earlier test
selector/projection error, corrected without changing product code.

Reproduce from `apps/world`, using a fresh paused loopback R5 Run:

```sh
LEITBILD_LOADING_TESTED_COMMIT=<exact-built-commit> bun scripts/physical-layout/native-map-operation-product-probe.ts /path/to/qa-run.json /path/to/evidence
```

Only test instrumentation observes actual worker geometry, native GL submissions,
Plan ink and acquired sample metadata. It installs no production test hook,
fabricates no values, and performs no production mutation. Browser profiles and
Chrome logs are deliberately excluded from this evidence bundle.
