# Agents room reliability — September 2026

Two independent faults made the World/Agents workspace appear broken:

- The identity-only Workspace seed correctly stopped creating a default Room and AI, but the split view still opened an empty Agents pane for World-only launches. Opening a Simulation Run now discovers an ordinary companion Room Definition, ensures one durable conversation for that Run, and selects it. No restored Cafe/Helper seeding or World-specific controller is involved.
- Both production Module environment files overrode their service-owned internal Host address with a retired public domain. Chat and standalone health worked, but an actual AI World-discovery call returned HTTP 404. The two stale overrides were removed without changing keys or other settings. Deployment now rejects conflicting provider-file routing and checks the effective Module process environments plus the Host API after restart. Production examples no longer suggest this override or obsolete Helper-model settings.

Coverage includes concurrent creation, reload/eviction, pinned Definition changes, Room deletion, failed membership rollback, same-Workspace scope, filtered discovery of the current Room, and a real Host → Agents → World broker integration. The bundled assistant's grants are read-only; the integration test verifies that simulation deletion is denied.

Live verification uses the existing Halden Run and the configured OpenAI provider, not a test response. Conversation content and associations are retained across service restart. A deployment health check is not a substitute for exercising this live path.
