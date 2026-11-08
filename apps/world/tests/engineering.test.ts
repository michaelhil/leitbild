import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineeringContinuationReceiptSchema, newWorkspaceId, type EngineeringInputBasis } from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { worldWorkspacePaths } from '../src/core/workspaces/paths.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const controller = { id: actorIdSchema.parse('actor:engineering-test'), label: 'Researcher', role: 'controller' as const }
const thermal = { profile: 'plant-thermal' as const, subjectId: 'plant:engineering-thermal' }
const coupled = scenarioDefinitionSchema.parse({
  ...builtinScenarioDefinitions.find(source => source.id === 'engineering-thermal')!, id: 'engineering-coupled-refusal',
  packs: [...builtinScenarioDefinitions.find(source => source.id === 'engineering-thermal')!.packs, { id: 'electric-grid', items: [{ type: 'grid', id: 'grid:engineering-coupled', label: 'Coupled Grid qualification fixture', location: [11.47, 59.086], model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.summer-night-low' }, automation: { ref: 'electric-grid.frequency.nordic-2025' } }] }],
  connections: [{ id: 'engineering-coupling', type: 'electrical', system: { objectId: thermal.subjectId, portId: 'grid-420kv' }, network: { objectId: 'grid:engineering-coupled', portId: 'unit-1-420kv' } }],
})
const qualify = (basis: EngineeringInputBasis) => ({ profile: basis.profile, profileRevision: basis.profileRevision, subjectId: basis.subjectId,
  frame: { epoch: basis.frame.epoch, scenarioDigest: basis.frame.scenarioDigest, restrictionRevision: basis.frame.restrictionRevision } })
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'engineering-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing }), workspaceId = newWorkspaceId()
  const config = { dataDir, workspaceId, scenarioDefinitions: [...builtinScenarioDefinitions, coupled],
    compileScenarioDefinition: (source: unknown) => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    runtimeAdapters: assembly.runtimeAdapters, idleRuntimeCloseTimer: () => () => {} }
  const registry = createSimulationRunRegistry(config)
  cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  return { registry, config, dataDir }
}
test('named research fixtures capture finite owner quantities with original qualification, and refuse later restriction/reset', async () => {
  const { registry } = await setup(), run = await registry.create({ scenarioId: 'engineering-thermal' })
  const basis = await registry.engineering.capture(run.id, thermal)
  expect(basis.quantities.map(row => [row.id, row.quantity, row.unit, row.quality])).toEqual([
    ['TAVG', 'temperature', 'degC', 'good'], ['core.totalThermalPowerMw', 'power', 'MW', 'good'],
  ])
  expect(basis.quantities.every(row => Number.isFinite(row.value))).toBe(true)
  expect(await registry.engineering.qualify(run.id, qualify(basis))).toEqual({ allowed: true })
  await run.setAgentRestrictions(controller, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(thermal.subjectId), deny: ['inspect'] }] }, 0)
  expect((await registry.engineering.qualify(run.id, qualify(basis))).allowed).toBe(false)
  await expect(registry.engineering.capture(run.id, thermal)).rejects.toThrow('shared engineering')
  const reset = await registry.reset(run.id)
  expect((await registry.engineering.qualify(reset.id, qualify(basis))).allowed).toBe(false)
  const grid = await registry.create({ scenarioId: 'engineering-grid' })
  const gridBasis = await registry.engineering.capture(grid.id, { profile: 'grid-balance', subjectId: 'grid:engineering' })
  expect(gridBasis.quantities).toHaveLength(5)
  expect(gridBasis.quantities.every(row => row.quantity === 'power' && row.unit === 'MW' && Number.isFinite(row.value))).toBe(true)
  const other = await registry.create({ scenarioId: 'planning-component-work' })
  await expect(registry.engineering.capture(other.id, { ...thermal, subjectId: 'plant:planning-work' })).rejects.toThrow('shared engineering')
}, 60_000)

test('a real coupled Plant/Grid clone is refused rather than silently dropping the Grid dependency', async () => {
  const { registry } = await setup(), run = await registry.create({ scenarioId: coupled.id })
  expect(registry.loadedCompiledScenario(run.id).connections).toHaveLength(1)
  expect(run.snapshot().objects.some(object => object.id === 'grid:engineering-coupled')).toBe(true)
  const full = await registry.captureContinuation(run.id, [])
  expect(full.manifest.runtimes).toHaveLength(2)
  expect(Object.keys(full.checkpoint.runtimeStates)).toHaveLength(2)
  await expect(registry.engineering.capture(run.id, thermal)).rejects.toThrow('shared engineering')
  await expect(registry.engineering.submit(run.id, 'test', 'coupled', { ...thermal, horizonSeconds: 1, variant: { label: 'Trip', actions: [{ atSeconds: 0, path: 'manualReactorTrip.pushbutton', value: true }] } })).rejects.toThrow('shared engineering')
  expect(registry.engineering.busy()).toBe(false)
}, 60_000)

test('active cancellation removes private runtimes; restart returns interrupted receipt for the original key and never resumes', async () => {
  const { registry, config, dataDir } = await setup(), run = await registry.create({ scenarioId: 'engineering-thermal' })
  const request = { ...thermal, horizonSeconds: 600, sampleEverySeconds: 1,
    variant: { label: 'Trip at ten seconds', actions: [{ atSeconds: 10, path: 'manualReactorTrip.pushbutton', value: true }] } }
  const first = await registry.engineering.submit(run.id, 'test', 'cancel', request)
  let result = first
  for (let i = 0; i < 200 && result.cases.length === 0; i++) {
    await Bun.sleep(50); result = await registry.engineering.inspect(run.id, { jobId: first.jobId })
  }
  expect(result.status).toBe('running')
  expect(result.cases.length).toBeGreaterThan(0)
  const cancelled = engineeringContinuationReceiptSchema.parse(await registry.engineering.cancel(run.id, { jobId: first.jobId }))
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.cases.every(row => row.status !== 'running')).toBe(true)
  expect((await registry.engineering.cancel(run.id, { jobId: first.jobId })).jobId).toBe(first.jobId)
  const directory = join(worldWorkspacePaths(dataDir, registry.workspaceId).root, 'engineering', first.jobId)
  expect((await readdir(directory)).sort()).toEqual(['origin.json', 'record.json'])
  await registry.shutdown()
  // The persisted state a killed supervisor leaves before final receipt write.
  const record = await Bun.file(join(directory, 'record.json')).json()
  record.receipt.status = 'running'; delete record.receipt.reason
  await writeFile(join(directory, 'record.json'), JSON.stringify(record))
  const restored = createSimulationRunRegistry(config)
  cleanups.push(() => restored.shutdown())
  const retry = await restored.engineering.submit(run.id, 'test', 'cancel', request)
  expect(retry.status).toBe('interrupted')
  expect(retry.jobId).toBe(first.jobId)
  expect(retry.origin).toEqual(first.origin)
  expect(restored.engineering.busy()).toBe(false)
  const rerun = await restored.engineering.submit(run.id, 'test', 'explicit-rerun', { ...request, replayJobId: first.jobId })
  expect(rerun.jobId).not.toBe(first.jobId)
  expect(rerun.origin).toEqual(first.origin)
  expect((await restored.engineering.cancel(run.id, { jobId: rerun.jobId })).status).toBe('cancelled')
}, 60_000)

test('refused future owner action is recorded and cannot claim the requested horizon', async () => {
  const { registry } = await setup(), run = await registry.create({ scenarioId: 'engineering-thermal' })
  const first = await registry.engineering.submit(run.id, 'test', 'refused', { ...thermal, horizonSeconds: 3, sampleEverySeconds: 1,
    variant: { label: 'Refused instructor-only fault', actions: [{ atSeconds: 1, path: 'pressurizer.reliefValveFailureActive', value: true }] } })
  let result = first
  for (let i = 0; i < 300 && ['queued', 'running'].includes(result.status); i++) {
    await Bun.sleep(50); result = await registry.engineering.inspect(run.id, { jobId: first.jobId })
  }
  expect(result.status).toBe('partial')
  expect(result.cases[0]!.reachedSeconds).toBe(3)
  expect(result.cases[1]!.reachedSeconds).toBeLessThan(3)
  expect(result.cases[1]!.interventions[0]!.status).toBe('refused')
  expect(result.cases[1]!.interventions[0]!.acceptedAt).toBeNull()
}, 60_000)

test('expired keys retain no physics and cannot reexecute until the source epoch is deliberately reset', async () => {
  const { registry, config, dataDir } = await setup(), run = await registry.create({ scenarioId: 'engineering-thermal' })
  const request = { ...thermal, horizonSeconds: 1, variant: { label: 'Trip', actions: [{ atSeconds: 0, path: 'manualReactorTrip.pushbutton', value: true }] } }
  const first = await registry.engineering.submit(run.id, 'test', 'expired', request)
  await registry.engineering.cancel(run.id, { jobId: first.jobId })
  await registry.shutdown()
  const directory = join(worldWorkspacePaths(dataDir, registry.workspaceId).root, 'engineering', first.jobId)
  const record = await Bun.file(join(directory, 'record.json')).json()
  record.receipt.expiresAt = '2026-01-01T00:00:00.000Z'
  await writeFile(join(directory, 'record.json'), JSON.stringify(record))
  const restored = createSimulationRunRegistry(config)
  cleanups.push(() => restored.shutdown())
  await expect(restored.engineering.submit(run.id, 'test', 'expired', request)).rejects.toThrow('submission key expired')
  expect(restored.engineering.busy()).toBe(false)
  expect(await readdir(directory)).toEqual(['expired.json'])
  const tombstone = await Bun.file(join(directory, 'expired.json')).json()
  expect(Object.keys(tombstone).sort()).toEqual(['epoch', 'expiredAt', 'jobId', 'keyDigest', 'requestDigest', 'sourceId', 'status'])
  expect(await restored.engineering.cancel(run.id, { jobId: first.jobId })).toEqual({ jobId: first.jobId, status: 'cancelled', evidenceAvailable: false })
  await restored.reset(run.id)
  const fresh = await restored.engineering.submit(run.id, 'test', 'expired', request)
  expect(fresh.jobId).not.toBe(first.jobId)
  await restored.engineering.cancel(run.id, { jobId: fresh.jobId })
}, 60_000)

test('revocation still permits safe cancellation; source reset/delete stop active and queued workers and remove deleted-source evidence', async () => {
  const { registry, dataDir } = await setup(), run = await registry.create({ scenarioId: 'engineering-thermal' })
  const request = { ...thermal, horizonSeconds: 600, sampleEverySeconds: 1,
    variant: { label: 'Trip later', actions: [{ atSeconds: 100, path: 'manualReactorTrip.pushbutton', value: true }] } }
  const first = await registry.engineering.submit(run.id, 'test', 'revoked', request)
  await run.setAgentRestrictions(controller, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(thermal.subjectId), deny: ['inspect'] }] }, 0)
  expect(await registry.engineering.cancel(run.id, { jobId: first.jobId })).toEqual({ jobId: first.jobId, status: 'cancelled', evidenceAvailable: false })
  await registry.reset(run.id)
  const second = await registry.engineering.submit(run.id, 'test', 'delete-active', request)
  let current = second
  for (let i = 0; i < 200 && current.cases.length === 0; i++) {
    await Bun.sleep(50); current = await registry.engineering.inspect(run.id, { jobId: second.jobId })
  }
  expect(current.status).toBe('running')
  const third = await registry.engineering.submit(run.id, 'test', 'delete-queued', request)
  expect(third.status).toBe('queued')
  expect(await registry.delete(run.id)).toBe(true)
  expect(registry.engineering.busy()).toBe(false)
  const root = join(worldWorkspacePaths(dataDir, registry.workspaceId).root, 'engineering')
  expect(await readdir(root)).toEqual([])
  await expect(registry.engineering.inspect(run.id, { jobId: second.jobId })).rejects.toThrow('unavailable')
  await Bun.sleep(100)
  expect(await readdir(root)).toEqual([])
}, 60_000)

test('real private worker reaches both cases, keeps source immutable, supports keyed retries, pinned replay and sample paging', async () => {
  const { registry } = await setup(), run = await registry.create({ scenarioId: 'engineering-thermal' })
  // Capture off the initial acquisition phase. Both comparison cases deliberately
  // start a new observation grid at this actual reached origin.
  await run.runMaximumPace('2026-11-08T10:00:00.500Z' as never, { shouldStop: () => false })
  const before = run.snapshot(), known = await registry.listKnown()
  const request = { ...thermal, horizonSeconds: 4, sampleEverySeconds: 3,
    variant: { label: 'Manual trip at one second', actions: [{ atSeconds: 1, path: 'manualReactorTrip.pushbutton', value: true }] } }
  const first = await registry.engineering.submit(run.id, 'test', 'first', request)
  expect((await registry.engineering.submit(run.id, 'test', 'first', request)).jobId).toBe(first.jobId)
  await expect(registry.engineering.submit(run.id, 'test', 'first', { ...request, horizonSeconds: 3 })).rejects.toThrow('different comparison')
  let result = first
  for (let i = 0; i < 300 && ['queued', 'running'].includes(result.status); i++) {
    await Bun.sleep(100)
    result = await registry.engineering.inspect(run.id, { jobId: first.jobId, limit: 100 })
  }
  expect(result.reason).toBeUndefined()
  expect(result.cases.map(row => row.reason)).toEqual([undefined, undefined])
  expect(result.status).toBe('completed')
  expect(result.cases.map(row => [row.status, row.reachedSeconds, row.sampleCount])).toEqual([['completed', 4, 4], ['completed', 4, 4]])
  expect(result.cases.map(row => row.samples.map(sample => sample.elapsedSeconds))).toEqual([[0, 1, 3, 4], [0, 1, 3, 4]])
  expect(Object.values(result.timings).every(value => Number.isFinite(value) && value > 0)).toBe(true)
  expect(result.cases[1]!.samples.at(-1)!.quantities.find(row => row.id === 'core.totalThermalPowerMw')!.value).toBeLessThan(result.cases[0]!.samples.at(-1)!.quantities.find(row => row.id === 'core.totalThermalPowerMw')!.value)
  expect(result.cases[1]!.interventions[0]!.status).toBe('accepted')
  expect((await registry.engineering.inspect(run.id, { jobId: first.jobId, offset: 1, limit: 1 })).cases[0]!.samples).toHaveLength(1)
  const after = run.snapshot()
  expect({ ...after, clock: { ...after.clock, updatedAt: null } }).toEqual({ ...before, clock: { ...before.clock, updatedAt: null } })
  expect((await registry.listKnown()).map(row => row.id)).toEqual(known.map(row => row.id))
  const ordinary = await registry.copy(run.id, {})
  for (const sample of result.cases[0]!.samples) {
    const second = sample.elapsedSeconds
    const target = new Date(Date.parse(before.clock!.currentTime) + second * 1000).toISOString() as never
    if (second > 0) {
      await run.runMaximumPace(target, { shouldStop: () => false })
      await ordinary.runMaximumPace(target, { shouldStop: () => false })
    }
    const originalBasis = await registry.engineering.capture(run.id, thermal)
    const ordinaryBasis = await registry.engineering.capture(ordinary.id, thermal)
    expect(originalBasis.quantities).toEqual(sample.quantities)
    expect(ordinaryBasis.quantities).toEqual(originalBasis.quantities)
    expect(sample.simulationAt).toBe(target)
  }
  const replay = await registry.engineering.submit(run.id, 'test', 'replay', { ...request, replayJobId: first.jobId })
  expect(replay.origin).toEqual(first.origin)
  expect((await registry.engineering.cancel(run.id, { jobId: replay.jobId })).status).toBe('cancelled')
}, 60_000)
