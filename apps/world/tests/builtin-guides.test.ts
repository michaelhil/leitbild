import { expect, test } from 'bun:test'
import { worldPacks, createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createGuideAttempt, currentGuideStep, advanceGuideAttempt } from '../src/core/guides/store.ts'
import { seesForRoleSet, runRolesOf } from '../src/core/model/roles.ts'
import { audienceVisibleTo } from '../src/core/model/audience.ts'
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createManualIdleTimer } from './helpers.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { evaluateGuideCondition } from '../src/core/guides/conditions.ts'

test('all bundled guides compile with exact owner targets and perspective-compatible human paths', async () => {
  expect(builtinScenarioDefinitions).toHaveLength(20)
  const panelIds = new Set(worldPacks.flatMap(pack => pack.ui?.surfacePanels.map(panel => panel.id) ?? []))
  let stateTasks = 0, promptTasks = 0
  for (const source of builtinScenarioDefinitions) {
    const compiled = await compileScenarioDefinition(source, worldPacks, { routing: createDirectRoutingAdapter() })
    const guide = compiled.guide!
    expect(guide, source.id).toBeDefined()
    expect(guide.steps.at(-1)?.id, source.id).toBe('explore')
    expect(guide.startPaused, source.id).toBe(source.id !== 'norway-situation-monitor')
    for (const step of guide.steps) {
      if (step.completion.kind === 'prompt-response') promptTasks++
      if (step.completion.kind === 'condition' && step.completion.condition.kind !== 'clock') stateTasks++
      for (const effect of step.effects) if (effect.target.kind === 'panel') expect(panelIds.has(effect.target.panelId), `${source.id}:${step.id}`).toBe(true)
    }
    // Walk each declared single-role and preset path without inventing physical/evidence success.
    const roleSets = compiled.roles === undefined ? [[]] : [
      ...compiled.roles.map(role => [role.id]), ...(compiled.rolePresets ?? []).map(preset => preset.roles),
    ]
    for (const roleIds of roleSets) {
      let attempt = createGuideAttempt(guide, roleIds, new Date().toISOString())
      let visited = 0
      while (attempt.status === 'active') {
        const step = currentGuideStep(guide, attempt, roleIds)
        const declaration = runRolesOf(compiled)
        const sees = declaration === null ? 'all' : seesForRoleSet(declaration, roleIds)
        for (const effect of step.effects) if (effect.target.kind === 'object') {
          const targetId = effect.target.objectId
          const object = compiled.initialObjects.find(object => object.id === targetId)
          expect(object, `${source.id}:${step.id}:${targetId}`).toBeDefined()
          expect(audienceVisibleTo(object!.audience, sees), `${source.id}:${step.id}:${roleIds}`).toBe(true)
        }
        attempt = advanceGuideAttempt({ guide, attempt, roleIds, expectedRevision: attempt.revision, action: 'skip', at: new Date().toISOString() })
        expect(++visited).toBeLessThanOrEqual(guide.steps.length)
      }
      expect(attempt.status).toBe('completed')
      expect(attempt.completed.every(record => record.outcome === 'skipped')).toBe(true)
    }
  }
  expect(stateTasks).toBeGreaterThanOrEqual(5)
  expect(promptTasks).toBeGreaterThanOrEqual(7)
})

test('the two novice dispatch guides choose eligible real units and their actual arrival gate is reachable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'builtin-guide-arrival-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, worldPacks, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldPacks),
    runtimeAdapters: assembly.runtimeAdapters, scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: worldPacks }), idleRuntimeCloseTimer: createManualIdleTimer().arm })
  try {
    for (const [scenarioId, unitId, taskId, roles] of [
      ['supply-run', 'unit:truck-3', 'task:field-kitchen', []],
      ['halden-emergency', 'unit:amb-4', 'task:tistedal-fall', ['group:ambulance']],
    ] as const) {
      const run = await registry.create({ scenarioId })
      const actor = { id: 'actor:guide-learner' as never, label: 'Guide learner', role: 'operator' as const, roleIds: roles }
      const source = registry.loadedCompiledScenario(run.id)
      const condition = source.guide!.steps.find(step => step.id === (scenarioId === 'supply-run' ? 'arrival' : 'ems-arrival'))!.completion
      if (condition.kind !== 'condition') throw new Error('The arrival step must read actual World evidence')
      const evidence = () => evaluateGuideCondition({ condition: condition.condition, runtime: run, actor, startsAt: source.world.startsAt, canInspect: id => run.inspectionPolicy(actor).canInspect(id) })
      expect((await evidence()).status).toBe('contradicted')
      const dispatched = await run.invokeCapability(actor, { capabilityId: 'world.einsatz.unit.send', input: { units: [unitId], to: { taskId } } })
      expect(dispatched.kind === 'command' && dispatched.result.ok, scenarioId).toBe(true)
      // Stop at the model's observed arrival, not an authored ETA or click receipt.
      await run.runMaximumPace(new Date(Date.parse(source.world.startsAt) + 15 * 60_000).toISOString() as never, {
        shouldStop: () => run.snapshot().objects.find(object => object.id === unitId)?.operational.status === 'on-task', onProgress: () => {},
      })
      expect((await evidence()).status, scenarioId).toBe('satisfied')
      await registry.close(run.id)
    }
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}, 60_000)
