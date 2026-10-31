import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, moduleCapabilityCollectionSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createKnowledge } from '@leitbild/knowledge'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createProcedureSourceService } from '../src/features/procedures/source.ts'
import { procedureRunReadViewSchema, procedureStepReadViewSchema, projectProcedureStepGuidance } from '../src/features/procedures/step-view.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

const registries: WorldWorkspaceRuntimeRegistry[] = []
const directories: string[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const revision = 'd'.repeat(40)
const frameworkCriterion = { type: 'comparison', tagId: 'PT-455', operator: '>', value: 0, unit: 'MPa', bound: 'value', evidence: 'engineering-diagnostic', source: '../basis.md#runner-fixture', maxAgeSeconds: 2 }
const e0 = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
---
# E-0 — Reactor Trip or Safety Injection
## Step 1 [id: verify-reactor-trip]
Check: Framework fixture only: read «TRIP-BKR-A», «TRIP-BKR-B», «NIS-PR-AVG». Its representative branch criterion checks the current pressure diagnostic «PT-455» is positive; it does not claim reactor trip qualification.
- Verified [outcome: normal] → #verify-turbine-trip
- Not verified [outcome: rno] → [[FR-S.1]]
\`\`\`procedure-decisions
${JSON.stringify([{ branchIndex: 0, condition: frameworkCriterion }])}
\`\`\`
## Step 2 [id: verify-turbine-trip]
Check: Framework transfer fixture: current pressure diagnostic «PT-455» is positive.
- Verified [outcome: normal] → [[ES-0.1]]
\`\`\`procedure-decisions
${JSON.stringify([{ branchIndex: 0, condition: frameworkCriterion }])}
\`\`\`

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
- id: TRIP-BKR-B
  description: reactor trip breaker B position
  sim-path: rps.trip_breaker.b.position
  units: enum[OPEN,CLOSED]
  equipment: reactor-protection-system
- id: NIS-PR-AVG
  description: nuclear instrumentation power-range average
  sim-path: nis.power_range.avg
  units: percent
  equipment: nuclear-instrumentation
- id: PT-455
  units: MPa
`

const es01 = `---
type: procedure
procedure-md: 0.7
procedure-id: ES-0.1
title: Reactor Trip Response
---
# ES-0.1 — Reactor Trip Response
## Step 1 [id: monitor]
Check: plant stable
- Stable [outcome: normal] → END
`

const setup = async (sourceCount = 1, scenarioId = 'test-plant') => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-procedure-ai-runner-'))
  directories.push(dataDir)
  const knowledge = createKnowledge({ revision, documents: [{ path: 'procedures/E-0.md', content: e0 }, { path: 'procedures/ES-0.1.md', content: es01 }, { path: 'basis.md', content: '# Basis\n## Runner fixture\nRepresentative positive pressure diagnostic for framework tests, not an E-0 operating criterion.' }] })
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    procedureSourceService: createProcedureSourceService({
      sources: ['runner-test', 'runner-other'].slice(0, sourceCount).map(sourceId => ({ sourceId, label: 'Runner fixture', repository: 'test', ref: 'publication', procedurePath: 'procedures' })),
      retentionDirectory: join(dataDir, 'procedure-publications'), loadKnowledge: async () => knowledge,
    }),
  })
  registries.push(registry)
  const workspaceId = newWorkspaceId()
  const provision = new Request(`http://world.test/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
  await handleWorldModuleApi(provision, new URL(provision.url), registry)
  const run = await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId })
  await run.setClock({ paused: true })
  const plant = run.snapshot().objects.find(object => object.packId === 'process-plant')!
  return { registry, workspaceId, run, plantId: plant.id }
}

const access = (workspaceId: WorkspaceId, actor: { kind: 'ai' | 'human'; id?: string; displayName?: string }) =>
  accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor })

const invoker = (registry: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, runId: string) =>
  async (capabilityId: string, input: unknown, actor: ReturnType<typeof access>): Promise<{ status: number; body: any }> => {
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }, input, access: actor }),
    })
    const response = await handleWorldModuleApi(request, new URL(request.url), registry)
    return { status: response!.status, body: await response!.json() }
  }

describe('the AI procedure runner through the World Module API', () => {
  test('current procedure state reads notes, authority and exact source/proof references without Pack acquisition', async () => {
    const { registry, workspaceId, run, plantId } = await setup(), invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' }), human = access(workspaceId, { kind: 'human' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = started.body.result.pinned.runId
    const packReads = spyOn(run, 'procedureObservations')
    try {
      const initial = await invoke('world.procedure.run.read', {}, ai)
      expect(initial.status).toBe(200)
      expect(procedureRunReadViewSchema.parse(initial.body.result)).toMatchObject({ observationsAcquired: false,
        run: { runId, driver: { kind: 'ai' } }, step: { id: 'verify-reactor-trip' } })
      const comment = 'Human annotation without takeover. '.repeat(30)
      expect((await invoke('world.procedure.step.update', { runId, stepId: 'verify-reactor-trip', comment, favorite: true }, human)).status).toBe(200)
      const snapshot = structuredClone(run.snapshot()), humanNote = await invoke('world.procedure.run.read', { runId }, ai)
      expect(humanNote.body.result.step.state).toEqual(snapshot.procedures!.runs.find(row => row.runId === runId)!.stepStates[0])
      expect(humanNote.body.result.run.driver.actorId).toBe('actor:ai:assistant')
      expect(humanNote.body.result.sequence).toBe(snapshot.seq)
      expect(packReads).not.toHaveBeenCalled()
      expect(run.snapshot().procedures).toEqual(snapshot.procedures)
      expect((await invoke('world.procedure.run.drive', { runId, action: 'claim' }, human)).status).toBe(200)
      expect((await invoke('world.procedure.run.read', { runId }, ai)).body.result.run.driver.kind).toBe('person')
      expect((await invoke('world.procedure.run.read', {}, ai)).status).toBe(404)
      expect((await invoke('world.procedure.run.drive', { runId, action: 'release' }, human)).status).toBe(200)
      expect((await invoke('world.procedure.run.read', { runId }, ai)).body.result.run.driver).toBeUndefined()
      expect((await invoke('world.procedure.run.drive', { runId, action: 'claim' }, ai)).status).toBe(200)
      await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Current positive framework pressure.' }, ai)
      packReads.mockClear()
      const moved = (await invoke('world.procedure.run.read', { runId }, ai)).body.result
      expect(moved.step.definition.input.stepId).toBe('verify-turbine-trip')
      const transferred = (await invoke('world.procedure.run.transition', { runId, stepId: 'verify-turbine-trip', branchIndex: 0, basis: 'Current positive framework pressure.' }, ai)).body.result
      packReads.mockClear()
      const destination = (await invoke('world.procedure.run.read', {}, ai)).body.result
      expect(destination.run.runId).toBe(transferred.next.run.runId)
      expect(destination.step.definition.input).toMatchObject({ sourcePath: 'procedures/ES-0.1.md', stepId: 'monitor' })
      const retained = (await invoke('world.procedure.run.read', { runId }, ai)).body.result
      expect(retained.run.status).toBe('transferred')
      expect(retained.step.state.decision.proof.input).toEqual(JSON.parse(transferred.view.state))
      expect(packReads).not.toHaveBeenCalled()
      expect((await invoke('world.procedure.run.read', { runId: 'procedure-run:missing' }, ai)).status).toBe(404)
    } finally { packReads.mockRestore() }
  })

  test('current-state snapshot is acquired after source lookup, so concurrent human notes and removals cannot be mislabeled', async () => {
    const { registry, workspaceId, run, plantId } = await setup(), invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' }), human = access(workspaceId, { kind: 'human' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = started.body.result.pinned.runId, original = run.procedureDocument.bind(run)
    for (const remove of [false, true]) {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      const sourceRead = spyOn(run, 'procedureDocument').mockImplementationOnce(async input => {
        const document = await original(input); entered.resolve(); await release.promise; return document
      })
      try {
        const pending = invoke('world.procedure.run.read', { runId }, ai)
        await entered.promise
        if (remove) await invoke('world.procedure.run.reset', { sourceId: 'runner-test', procedureId: 'E-0', scope: { plantId } }, human)
        else await invoke('world.procedure.step.update', { runId, stepId: 'verify-reactor-trip', comment: 'Human changed this while the retained source loaded.' }, human)
        release.resolve()
        const result = await pending
        if (remove) expect(result.body.error.code).toBe('procedure_run_not_found')
        else {
          expect(result.body.result.step.state.comment).toBe('Human changed this while the retained source loaded.')
          expect(result.body.result.sequence).toBe(run.snapshot().seq)
          expect(result.body.result.simulationTime).toBe(run.snapshot().clock!.currentTime)
        }
      } finally { release.resolve(); sourceRead.mockRestore() }
    }
  })

  test('step reads and scoped waits opt out of static guidance while current evidence, ownership and pinned identity stay complete', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const start = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = start.body.result.pinned.runId
    expect(start.body.result.next.step.blocks.length).toBeGreaterThan(0)
    expect(start.body.result.next).not.toHaveProperty('guidanceIncluded')
    const comment = 'The complete current checkpoint and retained acquisition notes. '.repeat(20)
    expect((await invoke('world.procedure.step.update', { runId, stepId: 'verify-reactor-trip', comment }, ai)).status).toBe(200)
    const snapshot = structuredClone(run.snapshot())
    const full = (await invoke('world.procedure.run.step.read', { runId }, ai)).body.result
    const current = (await invoke('world.procedure.run.step.read', { runId, includeGuidance: false }, ai)).body.result
    expect(procedureStepReadViewSchema.parse(current)).toEqual(projectProcedureStepGuidance(full, false))
    expect(current.step.state.comment).toBe(comment)
    expect(current.step.branchAssessments).toEqual(full.step.branchAssessments)
    expect(current.step.definition).toEqual(full.step.definition)
    expect(current.tags).toEqual(full.tags.map(({ description: _description, notes: _notes, ...tag }: Record<string, unknown>) => tag))
    expect(current.csfs).toEqual(full.csfs)
    expect((await invoke('world.procedure.run.step.read', { runId, includeGuidance: true }, ai)).body.result).toEqual(full)
    const waited = (await invoke('world.simulation-run.wait', { simulationSeconds: 1, procedureRunId: runId, includeGuidance: false }, ai)).body.result
    expect(waited.reason).toBe('clock-paused')
    expect(procedureStepReadViewSchema.parse(waited.next)).toEqual(current)
    expect((await invoke('world.simulation-run.wait', { simulationSeconds: 1, procedureRunId: runId }, ai)).body.result.next).toEqual(full)
    expect((await invoke('world.simulation-run.wait', { simulationSeconds: 1, includeGuidance: false }, ai)).status).toBe(400)
    expect(run.snapshot().procedures).toEqual(snapshot.procedures)
    expect(run.snapshot().objects).toEqual(snapshot.objects)
    expect(run.snapshot().seq).toBe(snapshot.seq)
    expect(run.snapshot().clock?.currentTime).toBe(snapshot.clock?.currentTime)
    expect(run.snapshot().clock?.paused).toBe(true)

    // New-step transition receipts remain full. Opted-out later reads carry the
    // new source/step reference, never silently reuse the caller's old guidance.
    const moved = (await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Current positive pressure supports this framework branch.' }, ai)).body.result
    expect(moved.next.step.blocks.length).toBeGreaterThan(0)
    expect(moved.next).not.toHaveProperty('guidanceIncluded')
    const transfer = (await invoke('world.procedure.run.transition', { runId, stepId: 'verify-turbine-trip', branchIndex: 0, basis: 'Current positive pressure supports this framework transfer.' }, ai)).body.result
    expect(transfer.next.step.blocks.length).toBeGreaterThan(0)
    expect(transfer.next.run.sourcePath).toBe('procedures/ES-0.1.md')
    const destinationId = transfer.next.run.runId
    const destination = (await invoke('world.procedure.run.step.read', { runId: destinationId, includeGuidance: false }, ai)).body.result
    expect(destination.step.definition.input).toMatchObject({ sourceRevision: revision, sourcePath: 'procedures/ES-0.1.md', stepId: 'monitor' })
    expect(destination.run).toEqual(transfer.next.run)
    const ownershipWait = invoke('world.simulation-run.wait', { procedureRunId: destinationId, includeGuidance: false,
      afterSequence: destination.sequence, events: [{ type: 'procedure.run.driver.changed', procedureRunId: destinationId }], maxWaitMs: 1_000 }, ai)
    expect((await invoke('world.procedure.run.drive', { runId: destinationId, action: 'claim' }, human)).status).toBe(200)
    const ownershipChanged = (await ownershipWait).body.result
    expect(ownershipChanged).toMatchObject({ reason: 'driver-changed', next: { guidanceIncluded: false, run: { driver: { kind: 'person' } } } })
    expect(ownershipChanged.next.step.definition).toEqual(destination.step.definition)
    const taken = (await invoke('world.procedure.run.step.read', { runId: destinationId, includeGuidance: false }, ai)).body.result
    expect(taken.run.driver.kind).toBe('person')
    expect(taken.step.definition).toEqual(destination.step.definition)

    const listed = moduleCapabilityCollectionSchema.parse(await (await handleWorldModuleApi(new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities`), new URL(`http://world.test/internal/workspaces/${workspaceId}/capabilities`), registry))!.json())
    for (const id of ['world.procedure.run.step.read', 'world.simulation-run.wait']) {
      const capability = listed.capabilities.find(row => row.id === id)!
      expect(capability.inputSchema).toHaveProperty('properties.includeGuidance')
      expect(JSON.stringify(capability.outputSchema)).toContain('guidanceIncluded')
    }
  })

  test('a bounded advance is live to step/context/display reads and waiting uses its exact target, including its completion pause', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const simulationRuns = registry.getLoaded(workspaceId)!.simulationRuns
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const display = async (kind: 'default' | 'sample', input: unknown) => {
      const request = new Request(`http://world.test/api/workspaces/${workspaceId}/world/simulation-runs/${run.id}/displays/${kind}`, { method: 'POST', body: JSON.stringify(input) })
      const response = (await handleSimulationRunApi(request, new URL(request.url), { registry: simulationRuns, accessContext: human, roleHolders: () => ({}) }))!
      return { status: response.status, body: await response.json() as any }
    }
    expect((await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)).status).toBe(200)
    const composed = await display('default', { subject: plantId })
    expect(composed.status).toBe(200)
    const state = composed.body.result.view.state
    expect((await display('sample', { state })).body.sample.at.paused).toBe(true)
    expect((await invoke('world.simulation-run.context', {}, ai)).body.result.context.text).toContain(' · PAUSED')

    const advance = await invoke('world.simulation-run.execution.advance', { minutes: 1.5, onComplete: 'pause' }, ai)
    expect(advance.status).toBe(202)
    const untilSimulationTime = advance.body.result.acceleration.targetSimulationTime as string
    expect(advance.body.result.acceleration.status).toBe('running')
    // Maximum pace intentionally leaves the realtime clock paused. Read ports
    // report actual execution, not that selected realtime playback state.
    expect(run.snapshot().clock!.paused).toBe(true)
    expect(simulationRuns.isAdvancing(run.id)).toBe(true)
    const [step, context, sampled] = await Promise.all([
      invoke('world.procedure.run.step.read', {}, ai),
      invoke('world.simulation-run.context', {}, ai),
      display('sample', { state }),
    ])
    expect(step.body.result).not.toHaveProperty('paused')
    expect(context.body.result.context.text).toContain(' · LIVE')
    expect(sampled.body.sample.at.paused).toBe(false)
    expect(Date.parse(step.body.result.simulationTime)).toBeLessThan(Date.parse(untilSimulationTime))
    // A fresh guarded transition while maximum pace owns the execution queue must not re-enter that queue.
    const duringAdvance = await invoke('world.procedure.run.transition', { runId: step.body.result.run.runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Positive current diagnostic in the framework fixture.', evidenceTagIds: ['PT-455'] }, ai)
    expect(duringAdvance.status).toBe(200)
    expect(run.snapshot().procedures?.runs[0]?.stepStates[0]?.decision?.criterion?.status).toBe('supported')
    let waited = await invoke('world.simulation-run.wait', { untilSimulationTime }, ai)
    while (waited.body.result?.reason === 'timeout') waited = await invoke('world.simulation-run.wait', { untilSimulationTime }, ai)
    expect(waited.status).toBe(200)
    expect(waited.body.result).toMatchObject({ reason: 'simulation-time', simulationTime: untilSimulationTime })
    // The target's tick can wake the wait before the maximum-pace job records
    // its terminal status. Completion, not an added relative wait, settles it.
    while ((await simulationRuns.executionStatus(run.id)).acceleration?.status === 'running') await new Promise<void>(resolve => setImmediate(resolve))
    expect((await invoke('world.simulation-run.wait', { untilSimulationTime }, ai)).body.result)
      .toMatchObject({ reason: 'simulation-time', simulationTime: untilSimulationTime, paused: true })
    expect(simulationRuns.isAdvancing(run.id)).toBe(false)
    expect((await invoke('world.procedure.run.step.read', {}, ai)).body.result.paused).toBe(true)
    expect((await display('sample', { state })).body.sample.at.paused).toBe(true)

    // A person's pause before the next target really interrupts the wait.
    const next = await invoke('world.simulation-run.execution.advance', { minutes: 1.5, onComplete: 'pause' }, ai)
    const nextTarget = next.body.result.acceleration.targetSimulationTime as string
    const waiting = invoke('world.simulation-run.wait', { untilSimulationTime: nextTarget }, ai)
    expect((await invoke('world.simulation-run.execution.set', { playback: 'paused' }, human)).status).toBe(200)
    const interrupted = await waiting
    expect(interrupted.body.result).toMatchObject({ reason: 'clock-paused', paused: true })
    expect(Date.parse(interrupted.body.result.simulationTime)).toBeLessThan(Date.parse(nextTarget))
    expect(simulationRuns.isAdvancing(run.id)).toBe(false)
  }, 60_000)

  test('a guarded transition on the live clock uses acquired simulation time and retains source pin and full proof', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = started.body.result.pinned.runId
    await run.setClock({ paused: false })
    const selected = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0,
      basis: 'Current positive pressure diagnostic.', evidenceTagIds: ['PT-455'] }, ai)
    expect(selected.status).toBe(200)
    const criterion = run.snapshot().procedures!.runs[0]!.stepStates[0]!.decision!.criterion!
    expect(criterion.status).toBe('supported')
    expect(criterion.readings[0]).toMatchObject({ tagId: 'PT-455', evidence: 'engineering-diagnostic', writable: false, provenance: 'runtime-model' })
    expect(Date.parse(criterion.simulationTime)).toBeGreaterThanOrEqual(Date.parse(criterion.readings[0]!.sampledAt!))
    expect(selected.body.result.next.run).toMatchObject({ sourceId: 'runner-test', sourceRevision: revision, sourcePath: 'procedures/E-0.md' })
    await run.setClock({ paused: true })
  })

  test('a transition receipt preserves its exact committed decision across revisits, without duplicating proof in the command journal', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, ai)
    const runId = started.body.result.pinned.runId
    const before = await invoke('world.procedure.run.step.read', { runId }, ai)
    expect(before.body.result.step.id).toBe('verify-reactor-trip')
    const first = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Current framework pressure diagnostic is positive.' }, ai)
    expect(first.status).toBe(200)
    const receipt = first.body.result.decision
    const recorded = run.events().find(event => event.type === 'procedure.branch.selected' && event.provenance.causedByCommandId === first.body.result.commandId)
    expect(receipt).toMatchObject({
      run: { runId, procedureId: 'E-0', sourceId: 'runner-test', sourceRevision: revision, sourcePath: 'procedures/E-0.md', scope: { plantId, label: 'Unit A1' } },
      event: { simulationRunId: run.id, runId, stepId: 'verify-reactor-trip', branchIndex: 0,
        selectedBy: 'actor:ai:assistant', criterionStatus: 'supported' },
    })
    expect(receipt.event).not.toHaveProperty('criterion')
    expect(first.body.result.view).toMatchObject({ viewType: 'procedure.decision', windowOnly: true })
    const locator = JSON.parse(first.body.result.view.state)
    expect(first.body.result.view.state.length).toBeLessThan(4096)
    const read = await invoke('world.procedure.decision.read', locator, ai)
    expect(read.status).toBe(200)
    expect(read.body.result.event).toEqual(recorded)
    expect(first.body.result.next.step.id).toBe('verify-turbine-trip')
    const commandEvent = run.events().find(event => event.type === 'command.result' && event.result.commandId === first.body.result.commandId)
    expect(commandEvent).not.toHaveProperty('result.decision')

    // A later refusal cannot claim a committed decision, even with a prior step's proof available.
    const eventsBeforeRefusal = run.events().filter(event => event.type === 'procedure.branch.selected').length
    const refused = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Old step is no longer current.' }, ai)
    expect(refused.status).toBe(409)
    expect(refused.body).not.toHaveProperty('result.decision')
    expect(run.events().filter(event => event.type === 'procedure.branch.selected')).toHaveLength(eventsBeforeRefusal)

    // Deliberate human navigation and a new selection do not rewrite the earlier receipt.
    expect((await invoke('world.procedure.step.update', { runId, stepId: 'verify-reactor-trip', currentStepId: 'verify-reactor-trip' }, human)).status).toBe(200)
    const second = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Human revisits the framework diagnostic.' }, human)
    expect(second.status).toBe(200)
    expect(second.body.result.decision.event.id).not.toBe(receipt.event.id)
    expect(second.body.result.decision.event.selectedBy).not.toBe(receipt.event.selectedBy)
    expect((await invoke('world.procedure.decision.read', locator, ai)).body.result.event).toEqual(recorded)
    expect(locator.commandId).toBe(first.body.result.commandId)
    expect(receipt.event.seq).toBeLessThan(second.body.result.decision.event.seq)
    expect(run.snapshot().procedures!.runs[0]!.stepStates.find(step => step.stepId === 'verify-reactor-trip')!.decision!.selectedBy)
      .toBe(second.body.result.decision.event.selectedBy)

    for (const changed of [
      { sourceRevision: 'e'.repeat(40) }, { sourceId: 'runner-other' }, { sourcePath: 'procedures/ES-0.1.md' },
      { eventId: second.body.result.decision.event.id }, { sequence: second.body.result.decision.event.seq },
      { commandId: second.body.result.commandId }, { runId: 'procedure-run:another' },
    ]) {
      const wrong = await invoke('world.procedure.decision.read', { ...locator, ...changed }, ai)
      expect(wrong.status).toBe(404)
      expect(wrong.body.error.code).toBe('procedure_decision_unavailable')
    }

    const restrictions = (await invoke('world.simulation-run.agent-restrictions.read', {}, human)).body.result
    expect((await invoke('world.simulation-run.agent-restrictions.set', { expectedRevision: restrictions.revision,
      restrictions: { operationIds: restrictions.operationIds, objects: [{ objectId: plantId, deny: ['inspect'] }] } }, human)).status).toBe(200)
    expect((await invoke('world.procedure.decision.read', locator, ai)).status).toBe(403)
    expect((await invoke('world.procedure.decision.read', locator, human)).body.result.event).toEqual(recorded)
    expect((await invoke('world.procedure.run.reset', { sourceId: 'runner-test', procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, human)).status).toBe(200)
    expect(run.snapshot().procedures!.runs.some(run => run.runId === runId)).toBe(false)
    expect((await invoke('world.procedure.decision.read', locator, human)).body.result.event).toEqual(recorded)
  })

  test('an AI agent starts and drives E-0, reads its step with live readings, and its accepted transition answers with the next step', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })

    const listed = moduleCapabilityCollectionSchema.parse(await (await handleWorldModuleApi(new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities`), new URL(`http://world.test/internal/workspaces/${workspaceId}/capabilities`), registry))!.json())
    const stepRead = listed.capabilities.find(capability => capability.id === 'world.procedure.run.step.read')!
    expect(stepRead).toMatchObject({ kind: 'query', risk: 'read', scope: { kind: 'resource', resourceType: 'world.simulation-run' } })
    const discoverable = [stepRead.id, stepRead.title, stepRead.description, ...(stepRead.searchTerms ?? [])].join(' ').toLowerCase()
    for (const term of ['run', 'continue', 'procedure', 'step']) expect(discoverable).toContain(term)
    expect(listed.capabilities.find(capability => capability.id === 'world.procedure.run.drive')).toMatchObject({ kind: 'command', risk: 'write' })

    // No catalog read: the start pins the only source's current publication and answers with the first step.
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, ai)
    expect(started.status).toBe(200)
    const runId = run.snapshot().procedures!.runs[0]!.runId
    expect(started.body.result).toMatchObject({ ok: true, pinned: { runId, sourceId: 'runner-test', sourceRevision: revision, sourcePath: 'procedures/E-0.md' },
      next: { run: { runId, currentStepId: 'verify-reactor-trip', stepNumber: 1 }, step: { id: 'verify-reactor-trip' } } })
    expect(run.snapshot().procedures!.runs[0]).toMatchObject({ sourceRevision: revision, driver: { kind: 'ai', actorId: 'actor:ai:assistant', label: 'Assistant' } })

    // "Continue": the one active run the caller drives, without a runId.
    const read = await invoke('world.procedure.run.step.read', {}, ai)
    expect(read.status).toBe(200)
    const view = read.body.result
    const readTags = structuredClone(view.tags) as Array<{ id: string; reading: { formatted: string; signal?: string; quality: string; note?: string } }>
    // An on/off reading names the model variable it is: here the breaker's closed state, not its position word.
    expect(readTags[0]!.reading).toMatchObject({ formatted: 'true boolean', signal: 'reactorTripBreakerA.closed' })
    expect(view.sequence).toBe(run.snapshot().seq)
    expect(view.paused).toBe(true)
    expect(view.run).toMatchObject({ runId, procedureId: 'E-0', plantId, unit: 'Unit A1', currentStepId: 'verify-reactor-trip', stepNumber: 1, totalSteps: 2, driver: { kind: 'ai' } })
    expect(view.step.branches.map((branch: { outcome: string; target: string; targetLabel?: string }) => `${branch.outcome} ${branch.target} ${branch.targetLabel ?? '-'}`)).toEqual(['normal verify-turbine-trip 2', 'rno FR-S.1 -'])
    expect(view.tags.map((tag: { id: string }) => tag.id)).toEqual(['TRIP-BKR-A', 'TRIP-BKR-B', 'NIS-PR-AVG', 'PT-455'])
    for (const tag of structuredClone(view.tags)) expect(tag.reading).toMatchObject({ formatted: expect.any(String), quality: expect.any(String) })
    expect(view.csfs.map((csf: { id: string }) => csf.id)).toEqual(['subcriticality', 'core-cooling', 'heat-sink', 'rcs-integrity', 'containment', 'rcs-inventory'])

    // A driver's precise human-input request is canonical state and remains inside Plant access rules.
    const requested = await invoke('world.procedure.run.request-input', { runId, stepId: 'verify-reactor-trip', issue: 'Confirm local rod indication.' }, ai)
    expect(requested.status).toBe(200)
    expect(requested.body.result.ok).toBe(true)
    expect((await invoke('world.procedure.run.step.read', { runId }, ai)).body.result.run.inputRequest).toMatchObject({
      stepId: 'verify-reactor-trip', issue: 'Confirm local rod indication.', requestedBy: 'actor:ai:assistant',
    })
    const restrictingOperator = { id: actorIdSchema.parse('operator:runner'), label: 'Runner operator', role: 'operator' as const }
    await run.setAgentRestrictions(restrictingOperator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(plantId), deny: ['change'] }] }, 0)
    expect((await invoke('world.procedure.run.request-input', { runId, stepId: 'verify-reactor-trip', issue: 'A different issue.' }, ai)).status).toBe(403)
    expect(run.snapshot().procedures!.runs[0]!.inputRequest?.issue).toBe('Confirm local rod indication.')
    await run.setAgentRestrictions(restrictingOperator, { operationIds: [], objects: [] }, 1)

    const basis = 'Test-only selection of the authored normal branch on the readings World takes; no plant judgement.'
    const beforeMalformedTransition = run.snapshot().seq
    // Progress belongs beside input in workspace_call. Silently stripping it
    // would commit the step without the chat line the driver intended to send.
    const malformed = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis,
      evidenceTagIds: ['TRIP-BKR-A'], say: 'This must not disappear while its transition succeeds.' }, ai)
    expect(malformed.status).toBe(400)
    expect(JSON.stringify(malformed.body)).toContain('say')
    expect(run.snapshot().seq).toBe(beforeMalformedTransition)
    expect(run.snapshot().procedures!.runs[0]).toMatchObject({ currentStepId: 'verify-reactor-trip', inputRequest: { issue: 'Confirm local rod indication.' } })
    const transition = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis, evidenceTagIds: ['TRIP-BKR-A', 'NIS-PR-AVG'] }, ai)
    expect(transition.status).toBe(200)
    expect(transition.body.result).toMatchObject({ ok: true, next: { run: { currentStepId: 'verify-turbine-trip', stepNumber: 2 }, step: { id: 'verify-turbine-trip' } } })
    expect(transition.body.result.next.step.branches).toEqual([{ index: 0, label: 'Verified', outcome: 'normal', targetKind: 'procedure', target: 'ES-0.1' }])
    expect(transition.body.result.next.sequence).toBe(run.snapshot().seq)
    const decision = run.snapshot().procedures!.runs[0]!.stepStates.find(step => step.stepId === 'verify-reactor-trip')!.decision!
    expect(decision).toMatchObject({ selectedBy: 'actor:ai:assistant', selectedByLabel: 'Assistant', basis })
    expect(decision.evidence!.map(item => item.tagId)).toEqual(['TRIP-BKR-A', 'NIS-PR-AVG'])
    // The decision records what World read, as the step read showed it (the plant is paused).
    const shown = readTags.filter(tag => tag.id !== 'TRIP-BKR-B' && tag.id !== 'PT-455')
    // A two-state reading names its model variable; any other starts with the value the step view showed.
    decision.evidence!.forEach((item, index) => {
      const reading = shown[index]!.reading
      expect(reading.signal === undefined ? item.reading.startsWith(reading.formatted) : item.reading === `${reading.signal} = ${reading.formatted.split(' ')[0]}`).toBe(true)
    })

    // A person's tick takes the run over; from then on the AI agent only reads it.
    const personTick = await invoke('world.procedure.step.update', { runId, stepId: 'verify-turbine-trip', assessment: 'complete' }, human)
    expect(personTick.status).toBe(200)
    expect(personTick.body.result.next).toBeUndefined()
    expect(run.snapshot().procedures!.runs[0]!.driver).toMatchObject({ kind: 'person', actorId: 'actor:operator' })
    const refused = await invoke('world.procedure.step.update', { runId, stepId: 'verify-turbine-trip', comment: 'Stop valves?' }, ai)
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('A person drives E-0 on Unit A1')
    expect((await invoke('world.procedure.run.reset', { sourceId: 'runner-test', procedureId: 'E-0', scope: { plantId } }, ai)).body.error.message).toContain('A person drives')

    // The step read keeps the AI inspection boundary, and reports unknown steps and runs as such.
    expect((await invoke('world.procedure.run.step.read', { runId, stepId: 'no-such-step' }, ai)).body.error.code).toBe('procedure_step_not_found')
    expect((await invoke('world.procedure.run.step.read', { runId: 'procedure-run:missing' }, ai)).body.error.code).toBe('procedure_run_not_found')
    const operator = { id: actorIdSchema.parse('operator:runner'), label: 'Runner operator', role: 'operator' as const }
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(plantId), deny: ['inspect'] }] }, 2)
    const denied = await invoke('world.procedure.run.step.read', { runId }, ai)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('agent_access_restricted')
    expect((await invoke('world.procedure.run.step.read', { runId }, human)).status).toBe(200)
  })

  test('explicit AI placekeeping and reset use the same validated capability and retain the actor', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = started.body.result.pinned.runId
    const updated = await invoke('world.procedure.step.update', { runId, stepId: 'verify-reactor-trip', assessment: 'unknown', favorite: true,
      currentStepId: 'verify-turbine-trip', comment: 'Explicitly requested operator placekeeping, not measured confirmation.' }, ai)
    expect(updated.status).toBe(200)
    expect(run.snapshot().procedures!.runs[0]!.stepStates[0]).toMatchObject({ assessment: 'unknown', favorite: true, updatedBy: 'actor:ai:assistant' })
    expect(run.snapshot().procedures!.runs[0]!.stepStates[0]!.decision).toBeUndefined()
    const reset = await invoke('world.procedure.run.reset', { sourceId: 'runner-test', procedureId: 'E-0', scope: { plantId } }, ai)
    expect(reset.status).toBe(200)
    expect(run.snapshot().procedures!.runs).toEqual([])
    expect(run.events().filter(event => event.type === 'procedure.run.reset').at(-1)).toMatchObject({ resetBy: 'actor:ai:assistant' })
  })

  test('claim and input-request receipts prove the exact owned run even with several active procedures', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const first = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, human)
    const second = await invoke('world.procedure.run.start', { procedureId: 'ES-0.1', scope: { plantId } }, human)
    const firstId = first.body.result.pinned.runId, secondId = second.body.result.pinned.runId
    for (const runId of [firstId, secondId]) {
      const claim = await invoke('world.procedure.run.drive', { runId, action: 'claim' }, ai)
      expect(claim.status).toBe(200)
      expect(claim.body.result.next.run).toMatchObject({ runId, driver: { kind: 'ai', actorId: 'actor:ai:assistant' } })
      expect(claim.body.result.next.sequence).toBe(run.snapshot().seq)
    }
    expect((await invoke('world.procedure.run.step.read', {}, ai)).status).toBe(409)
    const input = await invoke('world.procedure.run.request-input', { runId: firstId, stepId: 'verify-reactor-trip', issue: 'Confirm local rod indication.' }, ai)
    expect(input.status).toBe(200)
    expect(input.body.result.next.run).toMatchObject({ runId: firstId, driver: { actorId: 'actor:ai:assistant' }, inputRequest: { requestId: input.body.result.commandId, stepId: 'verify-reactor-trip' } })
    expect(run.snapshot().procedures!.runs.find(candidate => candidate.runId === secondId)!.inputRequest).toBeUndefined()
    const release = await invoke('world.procedure.run.drive', { runId: firstId, action: 'release' }, ai)
    expect(release.status).toBe(200)
    expect(release.body.result.next).toBeUndefined()
    expect(run.snapshot().procedures!.runs.find(candidate => candidate.runId === firstId)!.inputRequest).toBeUndefined()
  })

  test('waiting on a human answer returns the exact transferred destination still driven by the AI', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = started.body.result.pinned.runId
    await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0,
      basis: 'Test setup uses recorded readings, not a qualification claim.', evidenceTagIds: ['TRIP-BKR-A'] }, ai)
    const input = await invoke('world.procedure.run.request-input', { runId, stepId: 'verify-turbine-trip', issue: 'Operator confirms the next procedure path.' }, ai)
    const waiting = invoke('world.simulation-run.wait', { afterSequence: input.body.result.next.sequence, procedureRunId: runId,
      events: [{ type: 'procedure.branch.selected', procedureRunId: runId }, { type: 'procedure.run.closed', procedureRunId: runId }] }, ai)
    expect((await invoke('world.procedure.run.transition', { runId, stepId: 'verify-turbine-trip', branchIndex: 0 }, human)).status).toBe(200)
    const continued = await waiting
    expect(continued.status).toBe(200)
    expect(continued.body.result.next.run).toMatchObject({ procedureId: 'ES-0.1', status: 'active', driver: { kind: 'ai', actorId: 'actor:ai:assistant' } })
    expect(continued.body.result.next.run.runId).not.toBe(runId)
    expect(run.snapshot().procedures!.runs.find(candidate => candidate.runId === runId)).toMatchObject({ status: 'transferred' })
  })

  test('an AI agent\'s transfer answers with the destination\'s current step, which it now drives', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, ai)
    const runId = started.body.result.pinned.runId
    await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Test-only selection.', evidenceTagIds: ['NIS-PR-AVG'] }, ai)
    // The transfer is qualified by its authored framework pressure diagnostic.
    const transfer = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-turbine-trip', branchIndex: 0, basis: 'Framework pressure diagnostic is positive.', evidenceTagIds: ['PT-455'] }, ai)
    expect(transfer.status).toBe(200)
    const destination = run.snapshot().procedures!.runs.find(candidate => candidate.procedureId === 'ES-0.1')!
    expect(run.snapshot().procedures!.runs.find(candidate => candidate.runId === runId)).toMatchObject({ status: 'transferred' })
    expect(destination).toMatchObject({ status: 'active', driver: { kind: 'ai', actorId: 'actor:ai:assistant' } })
    expect(transfer.body.result.next).toMatchObject({ run: { runId: destination.runId, procedureId: 'ES-0.1', currentStepId: 'monitor', stepNumber: 1 }, step: { id: 'monitor' } })
    expect(transfer.body.result.decision).toMatchObject({
      run: { runId, procedureId: 'E-0', sourceId: 'runner-test', sourceRevision: revision, sourcePath: 'procedures/E-0.md', scope: { plantId } },
      event: { runId, stepId: 'verify-turbine-trip', targetKind: 'procedure', target: 'ES-0.1', criterionStatus: 'supported' },
    })
    const historical = await invoke('world.procedure.decision.read', JSON.parse(transfer.body.result.view.state), ai)
    expect(historical.body.result.event).toEqual(run.events().find(event => event.type === 'procedure.branch.selected' && event.provenance.causedByCommandId === transfer.body.result.commandId))
    expect(transfer.body.result.decision.run.runId).not.toBe(transfer.body.result.next.run.runId)
  })

  test('human takeover after an AI read holds every Plant operation, while another unit remains direct', async () => {
    const { registry, workspaceId, run, plantId } = await setup(1, 'halden-power-complex')
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const write = { plantId, tagId: 'CHG-PUMP-B', value: true }
    expect((await invoke('world.process-plant.control.write', write, ai)).status).toBe(200)
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, ai)
    const runId = started.body.result.pinned.runId
    expect((await invoke('world.procedure.run.step.read', { runId }, ai)).body.result.run.driver.kind).toBe('ai')
    // This commits after the AI read and before its next physical command.
    await invoke('world.procedure.run.drive', { runId, action: 'claim' }, human)
    for (const [operation, input] of [
      ['world.process-plant.control.write', { ...write, value: false }],
      ['world.process-plant.control.ramp', { plantId, tagId: 'RCP-A-SPD', targetValue: 0.9, durationSeconds: 30 }],
      ['world.process-plant.action.invoke', { plantId, actionId: 'turbine-trip', parameters: {} }],
      ['world.process-plant.actuation.reset', { plantId, ruleId: 'reactor-manual-trip' }],
      ['world.process-plant.ic.lifecycle', { plantId, lifecycleId: 'any', action: 'acknowledge' }],
    ] as const) {
      const refused = await invoke(operation, input, ai)
      expect(refused.status).toBe(409)
      expect(refused.body.error.message).toContain('A person drives E-0')
    }
    const otherPlant = run.snapshot().objects.find(object => object.packId === 'process-plant' && object.id !== plantId)!
    expect((await invoke('world.process-plant.control.write', { plantId: otherPlant.id, tagId: 'RX-TRIP-MAN', value: true }, ai)).status).toBe(200)
    expect((await invoke('world.process-plant.control.write', { ...write, value: false }, human)).status).toBe(200)
    const transition = await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0,
      basis: 'Cannot overrule a person.', evidenceTagIds: ['TRIP-BKR-A'] }, ai)
    expect(transition.status).toBe(409)
    await invoke('world.procedure.run.drive', { runId, action: 'release' }, human)
    await invoke('world.procedure.run.drive', { runId, action: 'claim' }, ai)
    expect((await invoke('world.process-plant.control.write', write, ai)).status).toBe(200)
  })

  test('a step read without runId names the runs when the caller drives none or several; a start without sourceId needs a sole source', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant', displayName: 'Assistant' })
    const human = access(workspaceId, { kind: 'human' })
    expect((await invoke('world.procedure.run.step.read', {}, ai)).body.error).toMatchObject({ code: 'procedure_run_not_found', message: expect.stringContaining('none is active') })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId, label: 'Unit A1' } }, human)
    expect(started.body.result.pinned).toMatchObject({ sourceRevision: revision })
    expect(started.body.result.next).toBeUndefined()
    const unclaimed = await invoke('world.procedure.run.step.read', {}, ai)
    expect(unclaimed.status).toBe(404)
    expect(unclaimed.body.error.message).toContain('You drive no active procedure run. Active: E-0 on Unit A1')
    expect(unclaimed.body.error.message).toContain('nobody drives')
    await invoke('world.procedure.run.drive', { runId: run.snapshot().procedures!.runs[0]!.runId, action: 'claim' }, ai)
    expect((await invoke('world.procedure.run.step.read', {}, ai)).body.result.run.procedureId).toBe('E-0')
    await invoke('world.procedure.run.start', { procedureId: 'ES-0.1', scope: { plantId, label: 'Unit A1' } }, ai)
    const ambiguous = await invoke('world.procedure.run.step.read', {}, ai)
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.body.error).toMatchObject({ code: 'procedure_run_ambiguous', message: expect.stringContaining('You drive 2 active procedure runs: E-0 on Unit A1') })

    const several = await setup(2)
    const severalAi = access(several.workspaceId, { kind: 'ai', id: 'assistant' })
    const refused = await invoker(several.registry, several.workspaceId, several.run.id)('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId: several.plantId } }, severalAi)
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('This Run has 2 procedure sources (runner-test, runner-other): name sourceId.')
    const named = await invoker(several.registry, several.workspaceId, several.run.id)('world.procedure.run.start', { sourceId: 'runner-other', procedureId: 'E-0', scope: { plantId: several.plantId } }, severalAi)
    expect(named.body.result.pinned).toMatchObject({ sourceId: 'runner-other', sourceRevision: revision })
  })

  test('an AI agent waits for a named change, a person taking over its run, or plant time, and sees only what it may inspect', async () => {
    const { registry, workspaceId, run, plantId } = await setup()
    const invoke = invoker(registry, workspaceId, run.id)
    const ai = access(workspaceId, { kind: 'ai', id: 'assistant' })
    const human = access(workspaceId, { kind: 'human' })
    const started = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId } }, ai)
    const runId = started.body.result.pinned.runId
    const before = started.body.result.next.sequence

    // A paused plant clock ends a wait for plant time at once; naming the run answers with its current step.
    const paused = await invoke('world.simulation-run.wait', { simulationSeconds: 30, procedureRunId: runId }, ai)
    expect(paused.body.result).toMatchObject({ reason: 'clock-paused', paused: true, fromSequence: run.snapshot().seq,
      next: { run: { runId, currentStepId: 'verify-reactor-trip' }, step: { id: 'verify-reactor-trip' }, tags: [{ id: 'TRIP-BKR-A' }, { id: 'TRIP-BKR-B' }, { id: 'NIS-PR-AVG' }, { id: 'PT-455' }] } })
    expect((await invoke('world.simulation-run.wait', { simulationSeconds: 30 }, ai)).body.result.next).toBeUndefined()

    // An event already committed after afterSequence answers at once.
    await invoke('world.procedure.run.transition', { runId, stepId: 'verify-reactor-trip', branchIndex: 0, basis: 'Test-only selection.', evidenceTagIds: ['NIS-PR-AVG'] }, ai)
    const selected = await invoke('world.simulation-run.wait', { afterSequence: before, events: [{ type: 'procedure.branch.selected', procedureRunId: runId }] }, ai)
    expect(selected.body.result).toMatchObject({ reason: 'event', fromSequence: before, events: [{ type: 'procedure.branch.selected', runId, branchIndex: 0 }] })
    expect(selected.body.result.waitedMs).toBeLessThan(1_000)

    // A person's take-over ends the AI agent's wait, whatever it waited for.
    const waiting = invoke('world.simulation-run.wait', { events: [{ type: 'interaction.signal.received', signalType: 'process-plant.proposal.approved' }], maxWaitMs: 10_000 }, ai)
    await Bun.sleep(300)
    expect((await invoke('world.procedure.run.drive', { runId, action: 'claim' }, human)).status).toBe(200)
    const changed = (await waiting).body.result
    expect(changed).toMatchObject({ reason: 'driver-changed', driverChanged: { runId, procedureId: 'E-0', change: 'procedure.run.driver.changed', by: 'actor:operator', driver: { kind: 'person' } } })
    expect(changed.waitedMs).toBeLessThan(5_000)

    // Events of a plant the AI agent may not inspect never answer its wait.
    const operator = { id: actorIdSchema.parse('operator:runner'), label: 'Runner operator', role: 'operator' as const }
    const hiddenFrom = run.snapshot().seq
    await invoke('world.procedure.run.transition', { runId, stepId: 'verify-turbine-trip', branchIndex: 0 }, human)
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(plantId), deny: ['inspect'] }] }, 0)
    const hidden = await invoke('world.simulation-run.wait', { afterSequence: hiddenFrom, events: [{ type: 'procedure.branch.selected' }], maxWaitMs: 1_000 }, ai)
    expect(hidden.body.result).toMatchObject({ reason: 'timeout', fromSequence: hiddenFrom })
    expect(hidden.body.result.events).toBeUndefined()
    expect((await invoke('world.simulation-run.wait', { afterSequence: hiddenFrom, events: [{ type: 'procedure.branch.selected' }], maxWaitMs: 1_000 }, human)).body.result.reason).toBe('event')
  })
})
