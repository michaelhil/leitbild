import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, SimulationRunEvent, SimulationRunId, EventId, IsoTimestamp, ProcedureDocument } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createSimulationRunStateStore } from '../src/core/simulation-runs/state-store.ts'
import { parseProcedureMarkdown } from '../src/core/procedures/procmd.ts'
import { procedureCommandEvents } from '../src/core/procedures/run-state.ts'

const source = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'leitbild-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  commitSha: 'test-revision',
  fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const e0Fixture = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
profile: nuclear-erg
category: diagnostic-eop
csfs-monitored: [subcriticality, core-cooling]
entry-triggers: [reactor-trip-signal]
---

# E-0 — Reactor Trip or Safety Injection

Entry procedure.

## Step 1 [id: verify-reactor-trip]
Check: reactor trip breakers «TRIP-BKR-A» OPEN
Caution: confirm subcriticality before any other action
- Verified → #verify-turbine-trip
  Because: rapid neutron flux decrease confirms core shutdown
- Not verified → [[FR-S.1]]
  Because: ATWS response required

## Step 2 [id: verify-turbine-trip]
Action: manually trip turbine if required
- Verified → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
`

const parseFixture = (): ProcedureDocument =>
  parseProcedureMarkdown({
    source,
    sourcePath: 'wiki/procedures/E-0.md',
    sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/blob/main/wiki/procedures/E-0.md',
    rawMarkdown: e0Fixture,
  })

const unitAScope = {
  systemId: 'halden-unit-a',
  label: 'Halden Unit A',
} as const

const unitBScope = {
  systemId: 'halden-unit-b',
  label: 'Halden Unit B',
} as const

describe('procedure system', () => {
  test('rejects missing and unsupported procedure formats', () => {
    expect(() => parseProcedureMarkdown({
      source,
      sourcePath: 'wiki/procedures/old.md',
      sourceUrl: 'https://example.test/old.md',
      rawMarkdown: e0Fixture.replace('procedure-md: 0.7', 'procedure-md: 0.6'),
    })).toThrow('procedure-md: 0.7')
    expect(() => parseProcedureMarkdown({
      source,
      sourcePath: 'wiki/procedures/unversioned.md',
      sourceUrl: 'https://example.test/unversioned.md',
      rawMarkdown: e0Fixture.replace('procedure-md: 0.7\n', ''),
    })).toThrow('procedure-md: 0.7')
  })

  test('parses procmd steps, branches, tags, and CSF metadata', () => {
    const procedure = parseFixture()

    expect(procedure.procedureId).toBe('E-0')
    expect(procedure.csfsMonitored).toEqual(['subcriticality', 'core-cooling'])
    expect(procedure.steps).toHaveLength(2)
    expect(procedure.steps[0]?.id).toBe('verify-reactor-trip')
    expect(procedure.steps[0]?.blocks.map(block => block.kind)).toEqual(['check', 'caution'])
    expect(procedure.steps[0]?.branches).toEqual([
      {
        label: 'Verified',
        target: 'verify-turbine-trip',
        targetKind: 'step',
        because: 'rapid neutron flux decrease confirms core shutdown',
        tagIds: [],
      },
      {
        label: 'Not verified',
        target: 'FR-S.1',
        targetKind: 'procedure',
        because: 'ATWS response required',
        tagIds: [],
      },
    ])
    expect(procedure.tags).toEqual([{
      id: 'TRIP-BKR-A',
      description: 'reactor trip breaker A position',
      simPath: 'rps.trip_breaker.a.position',
      units: 'enum[OPEN,CLOSED]',
      equipment: 'reactor-protection-system',
    }])
  })

  test('procedure commands create durable run-state events and restore into snapshots', async () => {
    let seq = 0
    const simulationRunId = 'procedure-test' as SimulationRunId
    const at = nowIso()
    const command: CommandEnvelope = {
      id: 'command:procedure-start' as CommandEnvelope['id'],
      simulationRunId,
      actorId: 'actor:operator' as ActorId,
      kind: 'procedure.run.start',
      targetObjectIds: [],
      payload: { sourceId: 'pwr-ops', procedureId: 'E-0', scope: unitAScope },
      issuedAt: at,
    }
    const started = await procedureCommandEvents({
      simulationRunId,
      at,
      command,
      procedures: undefined,
      factory: {
        eventId: () => `event:${++seq}` as EventId,
        nextSeq: () => seq,
      },
      readDocument: async () => parseFixture(),
    })
    if (!started) throw new Error('procedure command was not handled')
    const startEvent = started[0] as SimulationRunEvent
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    store.apply(startEvent)
    const runId = store.snapshot().procedures?.runs[0]?.runId
    if (!runId) throw new Error('procedure run was not projected')
    expect(store.snapshot().procedures?.runs[0]?.scope).toEqual(unitAScope)
    expect(store.snapshot().procedures?.runs[0]?.currentStepId).toBe('verify-reactor-trip')

    const update = await procedureCommandEvents({
      simulationRunId,
      at,
      command: {
        ...command,
        id: 'command:procedure-step' as CommandEnvelope['id'],
        kind: 'procedure.step.update',
        payload: {
          runId,
          stepId: 'verify-reactor-trip',
          assessment: 'complete',
          favorite: true,
          currentStepId: 'verify-turbine-trip',
        },
      },
      procedures: store.snapshot().procedures,
      factory: {
        eventId: () => `event:${++seq}` as EventId,
        nextSeq: () => seq,
      },
      readDocument: async () => parseFixture(),
    })
    if (!update) throw new Error('procedure update command was not handled')
    store.apply(update[0] as SimulationRunEvent)
    expect(store.snapshot().procedures?.runs[0]?.currentStepId).toBe('verify-turbine-trip')

    expect(store.snapshot().procedures?.runs[0]?.stepStates).toEqual([{
      stepId: 'verify-reactor-trip',
      assessment: 'complete',
      favorite: true,
      updatedAt: at,
      updatedBy: 'actor:operator' as ActorId,
    }])
  })

  test('procedure runs are scoped per unit and reset clears only the selected unit procedure', async () => {
    let seq = 0
    const simulationRunId = 'procedure-test' as SimulationRunId
    const at = nowIso()
    const baseCommand = {
      simulationRunId,
      actorId: 'actor:operator' as ActorId,
      kind: 'procedure.run.start',
      targetObjectIds: [],
      issuedAt: at,
    } satisfies Omit<CommandEnvelope, 'id' | 'payload'>
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0 })
    const commandFactory = {
      eventId: () => `event:${++seq}` as EventId,
      nextSeq: () => seq,
    }

    for (const [id, scope] of [['command:start-a', unitAScope], ['command:start-b', unitBScope]] as const) {
      const events = await procedureCommandEvents({
        simulationRunId,
        at,
        command: {
          ...baseCommand,
          id: id as CommandEnvelope['id'],
          payload: { sourceId: 'pwr-ops', procedureId: 'E-0', scope },
        },
        procedures: store.snapshot().procedures,
        factory: commandFactory,
        readDocument: async () => parseFixture(),
      })
      if (!events) throw new Error('procedure command was not handled')
      store.apply(events[0] as SimulationRunEvent)
    }

    expect(store.snapshot().procedures?.runs.map(run => run.scope.systemId).sort()).toEqual([
      'halden-unit-a',
      'halden-unit-b',
    ])

    let duplicate = 'accepted'
    try {
      await procedureCommandEvents({
        simulationRunId,
        at,
        command: {
          ...baseCommand,
          id: 'command:duplicate-a' as CommandEnvelope['id'],
          payload: { sourceId: 'pwr-ops', procedureId: 'E-0', scope: unitAScope },
        },
        procedures: store.snapshot().procedures,
        factory: commandFactory,
        readDocument: async () => parseFixture(),
      })
    } catch (err) {
      duplicate = err instanceof Error ? err.message : String(err)
    }
    expect(duplicate).toContain('reset it before starting another run')

    const reset = await procedureCommandEvents({
      simulationRunId,
      at,
      command: {
        ...baseCommand,
        id: 'command:reset-a' as CommandEnvelope['id'],
        kind: 'procedure.run.reset',
        payload: { sourceId: 'pwr-ops', procedureId: 'E-0', scope: unitAScope },
      },
      procedures: store.snapshot().procedures,
      factory: commandFactory,
      readDocument: async () => parseFixture(),
    })
    if (!reset) throw new Error('procedure reset command was not handled')
    store.apply(reset[0] as SimulationRunEvent)

    expect(store.snapshot().procedures?.runs.map(run => run.scope.systemId)).toEqual(['halden-unit-b'])
  })
})
