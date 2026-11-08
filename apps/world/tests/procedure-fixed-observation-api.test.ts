import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { createKnowledge } from '@leitbild/knowledge'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { actorIdSchema } from '../src/core/model/ids.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createProcedureSourceService } from '../src/features/procedures/source.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

// This small protocol fixture exercises the actual Plant and historian through
// the World API. It is deliberately not another copy of an operating procedure.
const revision = 'f'.repeat(40), sourceId = 'fixed-observation-fixture', procedureId = 'FIXED-OBSERVATION'
const sourcePath = `procedures/${procedureId}.md`, basisSource = '../basis.md#protocol'
const model = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'fixed-observation-test', loopCount: 4 }))
const basis = { modelRef: model.modelRef, modelDigest: model.modelDigest, source: basisSource,
  description: 'Test-only admission protocol. Positive pressure and four N16 readings are not reactor operating qualification.' }
const loops = ['A', 'B', 'C', 'D']
const fixture = testScenarioDefinitions.find(definition => definition.id === 'test-plant')!
const definition = { ...fixture, id: 'fixed-observation-plant',
  // Remove the persistence fixture's intentional off-design overrides. This
  // protocol needs the same reference model identity as its native basis.
  packs: fixture.packs.map(pack => ({ ...pack, items: pack.items.map(item => ({ ...item, operatingPoint: { ref: 'process-plant.pwr.full-power' } })) })) }
const pressure = { type: 'comparison', signal: { tagId: 'PT-455' }, operator: '>', value: 0, unit: 'MPa' }
const guard = { type: 'all', conditions: [pressure, ...loops.map(loop => ({ type: 'comparison', signal: { tagId: `SG-${loop}-N16` }, operator: '<=', value: .03, unit: 'mSv/h' }))] }
const responseQuery = { basis, condition: guard, startingCondition: guard, windowSeconds: 5,
  comparisons: [
    { signal: { tagId: 'PT-455' }, statistic: 'minimum', operator: '>', value: 0, unit: 'MPa' },
    ...loops.map(loop => ({ signal: { tagId: `SG-${loop}-N16` }, statistic: 'maximum', operator: '<=', value: .03, unit: 'mSv/h' })),
  ] }
const binding = (capabilityId: string, input: unknown) => ({ capabilityId, input, source: basisSource, maxAgeSeconds: 0 })
const decisions = (observation: unknown) => `\`\`\`procedure-decisions\n${JSON.stringify([{ branchIndex: 0, observation }])}\n\`\`\``
const source = `---
type: procedure
procedure-md: 0.7
procedure-id: ${procedureId}
title: Fixed observation admission protocol fixture
---
# Fixed observation admission protocol fixture
This is a software regression fixture, not an operating instruction.
## Step 1 [id: prepare]
Pair: [id: start, criterion: 0]
Check: Acquire the actual positive pressure and all four N16 readings before the interval.
- Initial frame acquired [outcome: normal] → #observe
${decisions(binding('world.process-plant.procedure-condition.evaluate', { basis, condition: guard }))}
## Step 2 [id: observe]
Pair: [id: response, criterion: 0]
Check: Assess every stored reading since the accepted starting frame, for at least five seconds.
- Interval checked [outcome: normal] → #observe
${decisions({ ...binding('world.process-plant.response.evaluate', responseQuery), afterStep: 'prepare' })}
`

type Wire = Record<string, any>
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-fixed-observation-'))
  let registry: WorldWorkspaceRuntimeRegistry | undefined
  cleanup.push(async () => { await registry?.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const knowledge = createKnowledge({ revision, documents: [
    { path: sourcePath, content: source },
    { path: 'basis.md', content: '# Basis\n## Protocol\nTest-only fixed observation, native acquisition and serialized admission.' },
  ] })
  registry = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), scenarioDefinitions: [definition], runtimeAdapters: createTestPackRuntimeAdapters(),
    procedureSourceService: createProcedureSourceService({ sources: [{ sourceId, label: 'Fixed observation fixture', repository: 'test', ref: 'publication', procedurePath: 'procedures' }],
      retentionDirectory: join(dataDir, 'publications'), loadKnowledge: async () => knowledge }) })
  const workspaceId = newWorkspaceId()
  const provision = new Request(`http://world.test/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
  expect((await handleWorldModuleApi(provision, new URL(provision.url), registry))!.status).toBe(201)
  const runs = registry.getLoaded(workspaceId)!.simulationRuns
  const run = await runs.create({ scenarioId: definition.id }); await run.setClock({ paused: true })
  const plantId = run.snapshot().objects.find(object => object.packId === 'process-plant')!.id
  const actor = { kind: 'ai', id: 'fixed-observation-agent' }
  const invoke = async (capabilityId: string, input: unknown, human = false): Promise<{ status: number; body: Wire }> => {
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: human ? { kind: 'human', displayName: 'Protocol operator' } : actor })
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId,
        resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }) })
    const result = await handleWorldModuleApi(request, new URL(request.url), registry!)
    return { status: result!.status, body: await result!.json() }
  }
  const good = async (capabilityId: string, input: unknown, human = false): Promise<Wire> => {
    const response = await invoke(capabilityId, input, human)
    expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200)
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
    return response.body.result
  }
  const advance = async (seconds: number) => {
    const started = await good('world.simulation-run.execution.advance', { minutes: seconds / 60, onComplete: 'pause' })
    const target = started.acceleration.targetSimulationTime
    let waited = await good('world.simulation-run.wait', { untilSimulationTime: target })
    while (waited.reason === 'timeout') waited = await good('world.simulation-run.wait', { untilSimulationTime: target })
    expect(waited.reason).toBe('simulation-time')
    while ((await runs.executionStatus(run.id)).acceleration?.status === 'running') await new Promise<void>(resolve => setImmediate(resolve))
    expect(run.snapshot().clock!.paused).toBe(true)
  }
  const pinned = (await good('world.procedure.run.start', { procedureId, scope: { plantId } })).pinned
  const transition = (stepId: string) => invoke('world.procedure.run.transition', { runId: pinned.runId, stepId, branchIndex: 0,
    basis: 'Inspect the exact pinned native protocol criterion at serialized commit.' })
  const check = async (stepId: string) => {
    const result = await good('world.procedure.run.checks.read', { runId: pinned.runId, stepId, sourceId, sourceRevision: revision, sourcePath, branchIndex: 0 }, true)
    expect(result.checks).toHaveLength(1)
    return result.checks[0] as Wire
  }
  const refused = async () => {
    const before = run.events().filter(event => event.type === 'procedure.branch.selected').length
    const result = await transition('observe')
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('procedure_branch_not_supported')
    expect(run.events().filter(event => event.type === 'procedure.branch.selected')).toHaveLength(before)
    expect(run.snapshot().procedures!.runs[0]!.currentStepId).toBe('observe')
    return result.body.error.details.assessment as Wire
  }
  const enter = async () => {
    const result = await transition('prepare')
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const proof = await good('world.procedure.decision.read', JSON.parse(result.body.result.view.state))
    expect(proof.event.criterion.status).toBe('supported')
    return proof.event.criterion.observation.result as Wire
  }
  const partialQuery = () => good('world.process-plant.response.evaluate', { targetObjectId: plantId, basis, condition: pressure,
    windowSeconds: 1, comparisons: [{ signal: { tagId: 'PT-455' }, statistic: 'minimum', operator: '>', value: 0, unit: 'MPa' }] })
  return { run, plantId, pinned, good, advance, enter, transition, check, refused, partialQuery }
}

test('World admission and operator checks use the complete authored interval, irrespective of a successful partial query', async () => {
  const c = await setup()
  await c.advance(5)
  const start = await c.enter()
  expect((await c.partialQuery()).status).toBe('satisfied')
  expect((await c.check('observe')).status).toBe('unknown')
  expect((await c.refused()).status).toBe('unknown')
  await c.advance(2)
  expect((await c.partialQuery()).status).toBe('satisfied')
  expect((await c.refused()).status).toBe('unknown')
  await c.advance(3)
  const checked = await c.check('observe')
  expect(checked.status).toBe('supported')
  const selected = await c.transition('observe')
  expect(selected.status, JSON.stringify(selected.body)).toBe(200)
  const proof = await c.good('world.procedure.decision.read', JSON.parse(selected.body.result.view.state))
  const observation = proof.event.criterion.observation
  expect(observation.afterStep).toBe('prepare')
  expect(observation.input).toEqual(responseQuery)
  expect(observation.result.status).toBe('satisfied')
  expect(observation.result.recordings.map((row: Wire) => row.signal.tagId).sort()).toEqual(['PT-455', ...loops.map(loop => `SG-${loop}-N16`)].sort())
  expect(observation.result.recordings.every((row: Wire) => row.requestedFrom === start.simulationTime)).toBe(true)
  expect(observation.result.current.simTimeMs - start.simTimeMs).toBeGreaterThanOrEqual(5_000)
  expect(checked.observation.result).toEqual(observation.result)
  // A genuine accepted repeat uses its checked endpoint, rather than the time
  // of a later query or the original acquisition of a previous interval.
  expect((await c.refused()).status).toBe('unknown')
  await c.advance(5)
  const repeated = await c.transition('observe')
  expect(repeated.status, JSON.stringify(repeated.body)).toBe(200)
  const nextProof = await c.good('world.procedure.decision.read', JSON.parse(repeated.body.result.view.state))
  expect(nextProof.event.criterion.observation.result.recordings.every((row: Wire) => row.requestedFrom === observation.result.current.simulationTime)).toBe(true)
})

test('manual repositioning cannot reuse an older accepted native starting frame', async () => {
  const c = await setup()
  await c.advance(5); await c.enter(); await c.advance(5)
  expect((await c.check('observe')).status).toBe('supported')
  await c.good('world.procedure.step.update', { runId: c.pinned.runId, stepId: 'observe', currentStepId: 'observe' }, true)
  expect((await c.partialQuery()).status).toBe('satisfied')
  const check = await c.check('observe')
  expect(check.status).toBe('unknown')
  expect(check.reasons.join(' ')).toMatch(/starting|transition|observed/i)
  expect((await c.refused()).status).toBe('unknown')
})

test('a restored SG D indication cannot roll its earlier failed sample out of the fixed authored interval', async () => {
  const c = await setup()
  await c.advance(5)
  const start = await c.enter()
  const fault = async (value: number) => {
    // An explicit scenario-owned tube-leak control creates actual native N16
    // response. No derived reading or historian sample is replaced by the test.
    const result = await c.run.invokeCapability({ id: actorIdSchema.parse('actor:fixed-observation-scenario'), label: 'Test tube leak', role: 'system' },
      { capabilityId: 'world.process-plant.control.write', input: { plantId: c.plantId, path: 'sgD.tubeLeakFraction', value } })
    expect(result.result).toMatchObject({ ok: true })
  }
  await fault(.005); await c.advance(2)
  const bad = await c.good('world.process-plant.signals.read', { plantId: c.plantId, signals: [{ tagId: 'SG-D-N16' }] })
  expect(bad.signals[0].variable.value).toBeGreaterThan(.03)
  await fault(0); await c.advance(60)
  expect((await c.partialQuery()).status).toBe('satisfied')
  const rolling = await c.good('world.process-plant.response.evaluate', { targetObjectId: c.plantId, basis, condition: guard,
    windowSeconds: 5, comparisons: responseQuery.comparisons })
  expect(rolling.status).toBe('satisfied')
  const check = await c.check('observe')
  expect(check.status).toBe('contradicted')
  const native = check.observation.result
  expect(native.current.status).toBe('satisfied')
  expect(native.recordings.every((row: Wire) => row.requestedFrom === start.simulationTime)).toBe(true)
  expect(native.recordings.find((row: Wire) => row.signal.tagId === 'SG-D-N16').maximum).toBeGreaterThan(.03)
  expect((await c.refused()).status).toBe('contradicted')
})
