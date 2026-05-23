# ADR 0018: Process Plant Signal Bindings And Control/Protection Substrate

## Status

Accepted.

## Context

Process-plant scenarios need to support operators, AI agents, procedures, alarms, trips, and future control-room surfaces. The same internal plant value may be referenced in several ways:

- as a compiled runtime variable path, such as `pressurizer.pressureMPa`
- as a procedure-facing tag, such as `PT-455`
- as a URI-like external reference, such as `process-plant://unit-1/pressurizer.pressureMPa`
- as an equipment-associated signal for display and documentation

The Samsinn PWR operations wiki already uses procedure tags and simulator bindings. Leitbild needs a clean equivalent without introducing a separate binding catalog that can drift from the graph, without making assumptions about fleets of identical units, and without turning process physics into event messages.

## Decision

Process signal identity is graph-owned metadata compiled into each process system.

The source of truth for a process signal is the compiled variable:

```text
{ controlRunId, systemId, variablePath }
```

`systemId` is always explicit. There is no implicit current unit, fleet-wide alias, or shared cross-unit namespace. Multi-unit scenarios are represented as multiple independent process systems.

Component and link variable descriptors may declare:

- `tagId`: a procedure/operator-facing signal identifier such as `PT-455`
- `equipmentId`: the equipment or component reference associated with the signal
- `description`: a concise human/agent description
- `externalRefs`: optional stable external references, including `process-plant://{systemId}/{variablePath}` when useful
- `capabilities`: optional operational visibility metadata when the derived defaults are insufficient
- `limits`: optional normal, operating, hard, and alarm ranges

`tagId` is unique only within one compiled process system. The same tag can exist in another system because API calls include `systemId`.

The previous `sensorId` and `actuatorId` split is rejected. A signal is one identity. Whether it can be written is determined by the variable descriptor's `writable` flag.

Capabilities are compiled from `writable`, `publish`, and `tagId` by default. Explicit capability overrides are allowed only on graph metadata and should be used sparingly. The compiler rejects tagged variables that are made invisible to operators, AI agents, and procedures.

Limits have two roles. `hardRange` is enforced during runtime writes and restore validation. `normalRange`, `operatingRange`, and `alarmLimits` are interpretation metadata for procedure reasoning, UI presentation, and future alarm/protection rule authoring.

The process-plant compiler builds a signal index from graph variables:

- by variable path
- by `tagId`
- searchable by text, tag, equipment, quantity, domain, writable flag, and publication policy
- carrying compiled capabilities and limits

No separate binding table is introduced in V1.

The pack query/API surface resolves tags directly:

```json
{
  "packId": "process-plant",
  "kind": "process-plant.signals.read",
  "payload": {
    "systemId": "unit-1",
    "signals": [{ "tagId": "PT-455" }]
  }
}
```

Commands use the same explicit signal reference shape:

```json
{
  "kind": "process-plant.control.write",
  "payload": {
    "systemId": "unit-1",
    "tagId": "PORV-456A",
    "value": 1
  }
}
```

Exactly one of `path` or `tagId` must be supplied. Unknown or non-writable signals fail explicitly.

Control/protection logic is pack-owned and deterministic. It reads process variable snapshots, evaluates typed declarative rules, queues validated writes for the next solver tick, and emits interaction signals for alarm/trip transitions. It does not mutate continuous physics through the event bus.

The V1 control/protection rule language supports only typed primitives:

- variable comparison/equality
- `all`, `any`, `not`, and voting conditions
- delay and latch behavior
- effects: alarm signal, trip signal, and validated variable write

Arbitrary expressions, user-authored code, and hidden procedure engines are out of scope for V1.

## Runtime Ordering

Each provider tick uses this order:

1. Apply queued external/control writes at the runtime phase boundary.
2. Run deterministic solver phases.
3. Evaluate control/protection rules against the completed tick snapshot.
4. Queue any rule writes for the next solver tick.
5. Emit alarm/trip interaction signals for state transitions.
6. Record telemetry/read-only trend samples.

This keeps continuous physics single-sourced in the variable table and prevents mid-solver mutation.

## Consequences

- AI agents can resolve procedure tags directly through the process-plant pack query surface.
- Procedure bindings live with the graph that defines the plant; they cannot silently diverge into a side table.
- `tagId` is readable and compact for operators, while `variablePath` remains stable and code-friendly.
- Multi-unit scenarios stay simple: every read/write includes `systemId`.
- Writable controls and read-only indications use the same signal shape and differ only by `writable`.
- Control/protection behavior is deterministic, replayable, and testable without adding a general scripting engine.
- Interaction signals are used for alarms/trips and operator-facing notifications, not for continuous physics.

## Guardrails

- Do not reintroduce `sensorId` or `actuatorId`.
- Do not add a separate binding catalog unless graph-owned signal metadata hits a documented limitation.
- Do not allow tag lookup without explicit `systemId`.
- Do not add unit-context aliases, fleet-level shortcuts, or cross-unit defaulting.
- Do not make procedure tags globally unique across independent process systems.
- Do not let control/protection rules write variables directly during a solver phase.
- Do not add arbitrary expression evaluation, JavaScript snippets, or generated runtime code to scenario-authored protection rules.
- Do not hide API failures behind fallbacks from tag to path or path to tag.
