# ADR 0010: Control Instance Memory and Persistence Lifecycle

## Decision

Leitbild will separate Control Instance state into three runtime/persistence layers:

- **Projected State**: the current canonical operational picture for a Control Instance.
- **Durable Journal**: meaningful accepted history for audit, debugging, replay of decisions, and later research instrumentation.
- **Live Change Feed**: realtime updates broadcast to connected clients.

All accepted updates still flow through the Control Instance runtime. The runtime applies valid updates to Projected State and broadcasts them to the Live Change Feed. The runtime persists only durable events to the Durable Journal.

High-frequency movement and other volatile updates are not durable journal entries by default. They update Projected State and connected clients, and they are captured in snapshots as the latest current truth.

Simulation providers keep **Provider Private State** and **Provider Projections** needed for their mechanics. They do not own the canonical shared operational picture and do not retain Control Instance history. Providers may observe committed Domain Events to update their private mechanics or projections.

## Rationale

The first sandbox deployment showed that treating every `object.upserted` event as durable history does not scale. A long-running Control Instance accumulated a large JSONL event log from per-second movement updates, and startup/rejoin paths had to read and retain too much history.

The three-layer model keeps the system simple while matching the different access patterns:

- current UI/API/AI reads need compact current truth,
- audit and debugging need meaningful history,
- browser tabs and displays need realtime changes,
- simulation providers need private mechanics, not global canonical memory.

One layer cannot satisfy all of these without either losing auditability or recreating an unbounded memory/log growth path.

## Consequences

- `snapshot.json` is the restart source for current object state.
- `events.jsonl` is a semantic journal, not a full motion trace.
- Volatile updates can advance snapshot sequence numbers without creating durable journal entries for every sequence number.
- Clients that need the current world should load snapshots. Live clients receive volatile updates over the realtime feed.
- A future stale-client replay policy should explicitly tell clients to reload the snapshot when their cursor is too old.
- Research-grade full motion recording is a separate explicit recording mode, not an accidental property of the operational journal.
- Event persistence classification is part of the Control Instance runtime, not simulation providers, so multi-provider memory policy stays consistent.

## Rejected Alternatives

### Persist every object update forever

Rejected because high-frequency simulation updates make event logs and runtime memory grow with elapsed wall-clock time instead of current object count or meaningful operational activity.

### Snapshot-only persistence

Rejected because commands, interaction signals, notifications, and semantic state transitions need durable audit and debugging history.

### Provider-owned persistence

Rejected because it fragments canonical truth across simulation providers and makes UI, API, AI, replay, and cross-provider interactions harder to reason about.

### Database-first rewrite

Deferred. A database-backed state store may become useful for cloud operations and queryability, but the immediate architectural issue is persistence disposition, not the storage engine.
