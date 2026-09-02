# Agents room reliability — September 2026

Two independent faults made the World/Agents workspace appear broken:

- The identity-only Workspace seed correctly stopped creating a default Room and AI, but the split view still opened an empty Agents pane for World-only launches. Opening a Simulation Run now discovers an ordinary companion Room Definition, ensures one durable conversation for that Run, and selects it. No restored Cafe/Helper seeding or World-specific controller is involved.
- Both production Module environment files overrode their service-owned internal Host address with a retired public domain. Chat and standalone health worked, but an actual AI World-discovery call returned HTTP 404. The two stale overrides were removed without changing keys or other settings. Deployment now rejects conflicting provider-file routing and checks the effective Module process environments plus the Host API after restart. Production examples no longer suggest this override or obsolete Helper-model settings.

Coverage includes concurrent creation, reload/eviction, pinned Definition changes, Room deletion, failed membership rollback, same-Workspace scope, filtered discovery of the current Room, and a real Host → Agents → World broker integration. The bundled assistant's grants are read-only; the integration test verifies that simulation deletion is denied.

Live verification uses the existing Halden Run and the configured OpenAI provider, not a test response. Conversation content and associations are retained across service restart. A deployment health check is not a substitute for exercising this live path.

That live check also exposed an independent World restart defect: the application entry point had no signal handler and the server's stop method did not await Workspace shutdown. A service restart could therefore interrupt final checkpoints and leave Weather ahead of the canonical Run clock. World now handles SIGTERM/SIGINT, stops incoming traffic, drains work, waits for every Run/Workspace checkpoint even if a sibling fails, and exits only after shutdown completes. A regression test launches the actual application process, runs a Weather scenario, terminates it and restores the Run in a new process. Already inconsistent Run checkpoints are not silently rewound or fabricated; recovery requires an explicit reset decision.

Capability discovery for an AI now omits output schemas and ungranted input schemas, and supports an exact Capability filter. A production read-only catalog previously put roughly 120,000 tokens into one response; full schemas remain available in the Host API for inspection.
