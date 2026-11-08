import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, planningWorldSourceSchema, type WorkspaceResourceReference } from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { createPlanningSourceEpoch, readPlanningSourceEpoch } from '../src/core/simulation-runs/planning-source-epoch.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const controller = { id: actorIdSchema.parse('actor:planning-test'), label: 'Researcher', role: 'controller' as const }
const responseDefinition = builtinScenarioDefinitions.find(source => source.id === 'planning-response')!
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planning-source-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing }), workspaceId = newWorkspaceId()
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId,
    scenarioDefinitions: [...builtinScenarioDefinitions, { ...responseDefinition, id: 'planning-with-roles', roles: [{ id: 'control', label: 'Controller', class: 'controller' as const }] }],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    runtimeAdapters: assembly.runtimeAdapters, idleRuntimeCloseTimer: () => () => {},
  })
  cleanup.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const source = (runId: string): WorkspaceResourceReference => planningWorldSourceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId })
  return { registry, source }
}

describe('shared planning sources', () => {
  test('captures actual Einsatz facts, stable digests and declared property changes', async () => {
    const { registry, source } = await setup()
    const run = await registry.create({ scenarioId: 'planning-response' })
    expect(run.snapshot().clock!.paused).toBe(true)
    const first = await run.planningSource.capture(source(run.id), 'einsatz', {})
    expect(first.subjects).toHaveLength(5)
    const facts = first.subjects.flatMap(subject => subject.facts)
    expect(facts.find(fact => fact.id === 'unit:planning-a/service-seconds')?.value).toBe(600)
    expect(facts.find(fact => fact.id === 'site:planning-receiving/receiving-slots')?.value).toBe(1)
    expect(Number(facts.find(fact => fact.id === 'unit:planning-a/arrival-seconds/task:planning-a')?.value)).toBeGreaterThan(60)
    expect(Number(facts.find(fact => fact.id === 'unit:planning-a/transfer-seconds/task:planning-a/site:planning-receiving')?.value)).toBeGreaterThan(0)
    expect((await run.planningSource.capture(source(run.id), 'einsatz', {})).digest).toBe(first.digest)
    const outcome = await run.invokeCapability(controller, { capabilityId: 'world.einsatz.unit.adjust', input: { unitId: 'unit:planning-a', properties: { preparationSeconds: 240 }, reason: 'Compare a different authored estimate' } })
    expect(outcome.kind === 'command' && outcome.result.ok).toBe(true)
    const changed = await run.planningSource.capture(source(run.id), 'einsatz', { subjectIds: first.qualification.subjectIds })
    expect(changed.digest).not.toBe(first.digest)
    expect(await run.planningSource.qualify({ profile: first.profile, qualification: first.qualification })).toEqual({ allowed: true })
  })

  test('denies shared capture and retained qualification after AI restrictions; missing subjects remain unavailable', async () => {
    const { registry, source } = await setup()
    const run = await registry.create({ scenarioId: 'planning-response' })
    const basis = await run.planningSource.capture(source(run.id), 'einsatz', {})
    await run.setAgentRestrictions(controller, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:planning-a'), deny: ['inspect'] }] }, 0)
    await expect(run.planningSource.capture(source(run.id), 'einsatz', {})).rejects.toThrow('shared research audience')
    expect((await run.planningSource.qualify({ profile: basis.profile, qualification: basis.qualification })).allowed).toBe(false)
    expect((await run.planningSource.qualify({ profile: basis.profile, qualification: { ...basis.qualification, restrictionRevision: 1, subjectIds: ['einsatz/unit/missing'] } })).allowed).toBe(false)
  })

  test('role-declaring sources refuse, restore retains epoch, copy and reset invalidate it', async () => {
    const { registry, source } = await setup()
    const roleRun = await registry.create({ scenarioId: 'planning-with-roles' })
    await expect(roleRun.planningSource.capture(source(roleRun.id), 'einsatz', {})).rejects.toThrow('without roles')
    const run = await registry.create({ scenarioId: 'planning-response' })
    const basis = await run.planningSource.capture(source(run.id), 'einsatz', {})
    const copied = await registry.copy(run.id, {})
    expect((await copied.planningSource.qualify({ profile: basis.profile, qualification: basis.qualification })).allowed).toBe(false)
    await registry.close(run.id)
    const restored = await registry.load(run.id)
    expect(await restored.planningSource.qualify({ profile: basis.profile, qualification: basis.qualification })).toEqual({ allowed: true })
    const reset = await registry.reset(run.id)
    expect((await reset.planningSource.qualify({ profile: basis.profile, qualification: basis.qualification })).allowed).toBe(false)
  })

  test('captures real public pump facts without fault controls or full graph', async () => {
    const { registry, source } = await setup()
    const run = await registry.create({ scenarioId: 'planning-component-work' })
    const basis = await run.planningSource.capture(source(run.id), 'process-plant', {})
    expect(basis.subjects.length).toBeGreaterThanOrEqual(2)
    expect(basis.subjects.every(subject => subject.kind === 'pump')).toBe(true)
    expect(basis.subjects.some(subject => subject.facts.some(fact => fact.id.endsWith('/nominal-flow')))).toBe(true)
    expect(JSON.stringify(basis)).not.toContain('startFailureActive')
    expect(JSON.stringify(basis)).not.toContain('faultTruth')
    const scoped = await run.planningSource.capture(source(run.id), 'process-plant', { subjectIds: [basis.subjects[0]!.locator] })
    expect(scoped.subjects).toHaveLength(1)
    await run.setAgentRestrictions(controller, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('plant:planning-work'), deny: ['inspect'] }] }, 0)
    await expect(run.planningSource.capture(source(run.id), 'process-plant', {})).rejects.toThrow('shared research audience')
  })

  test('epoch reads never create state; lifecycle writes replace epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'planning-epoch-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'planning-source-epoch.json')
    expect(await readPlanningSourceEpoch(path)).toBeNull()
    const first = await createPlanningSourceEpoch(path)
    expect(await readPlanningSourceEpoch(path)).toBe(first)
    expect(await createPlanningSourceEpoch(path)).not.toBe(first)
  })
})
