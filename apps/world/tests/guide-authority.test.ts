import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId, presentationRecipientSchema } from '@leitbild/contracts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { runGuideOperation, runPresentationOperation } from '../src/core/guides/operations.ts'
import { guideDefinitionSchema } from '../src/core/guides/model.ts'
import { createPresentationDelivery } from '../src/core/guides/presentation.ts'
import { createGuideAttempt } from '../src/core/guides/store.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { guideReadingSchema } from '../src/core/guides/wire.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createWorldApplicationAssembly, worldPacks } from '../src/app-assembly.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createManualIdleTimer } from './helpers.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-guide-authority-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions, runtimeAdapters: assembly.runtimeAdapters,
    compileScenarioDefinition: source => compileScenarioDefinition(source, worldPacks, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldPacks),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: worldPacks }), idleRuntimeCloseTimer: createManualIdleTimer().arm })
  cleanup.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const source = { ...builtinScenarioDefinitions.find(source => source.id === 'supply-run')!, id: 'guide-authority',
    roles: [{ id: 'blue', label: 'Blue learner', class: 'operator' as const }, { id: 'red', label: 'Red learner', class: 'operator' as const }],
    guide: guideDefinitionSchema.parse({ id: 'orientation', title: 'Orientation', steps: [{ id: 'locate', title: 'Locate', instruction: 'Locate the unit in your current picture',
      effects: [{ id: 'unit', target: { kind: 'object', objectId: 'unit:truck-1' }, action: { kind: 'highlight' } }], completion: { kind: 'acknowledge' } }] }),
  }
  await registry.createScenario(source)
  const runtime = await registry.create({ scenarioId: source.id })
  const actor = (role: string): Actor => ({ id: `actor:${role}` as never, label: role, role: 'operator', roleIds: [role] })
  const blueCall = { registry, runId: runtime.id, actor: actor('blue') }, redCall = { registry, runId: runtime.id, actor: actor('red') }
  const blue = presentationRecipientSchema.parse(await runPresentationOperation('register', { clientId: 'blue-client', documentId: 'blue-doc' }, blueCall))
  const red = presentationRecipientSchema.parse(await runPresentationOperation('register', { clientId: 'red-client', documentId: 'red-doc' }, redCall))
  const started = guideReadingSchema.parse(await runGuideOperation('start', { recipient: blue }, blueCall))
  return { registry, runtime, blueCall, redCall, blue, red, started }
}

test('rejected cross-perspective Show cannot steal the valid document lease or supersede its pending cues', async () => {
  const { registry, blueCall, redCall, blue, red, started } = await setup()
  const before = registry.presentation.pending(blue)
  expect(before).toHaveLength(1)
  await expect(runGuideOperation('show', { attemptId: started.attemptId, recipient: red, takeover: true }, redCall)).rejects.toMatchObject({ code: 'guide_perspective_changed' })
  expect(() => registry.presentation.assertGuide(started.attemptId!, blue)).not.toThrow()
  expect(registry.presentation.pending(blue)).toEqual(before)
  expect((await runGuideOperation('read', { attemptId: started.attemptId, recipient: blue }, blueCall) as { revision: number }).revision).toBe(started.revision!)
})

test('stale-CAS Resume cannot steal a current lease or retire pending effects before rejecting the update', async () => {
  const { registry, blueCall, blue, started } = await setup()
  // A second document in the same perspective may explicitly request takeover;
  // the stale progress mutation is still rejected before any authority changes.
  const other = presentationRecipientSchema.parse(await runPresentationOperation('register', { clientId: 'second-blue', documentId: 'second-blue' }, blueCall))
  const before = registry.presentation.pending(blue)
  await expect(runGuideOperation('advance', { attemptId: started.attemptId, expectedRevision: started.revision! + 1, recipient: other, action: 'resume', takeover: true }, blueCall)).rejects.toMatchObject({ code: 'guide_progress_conflict' })
  expect(() => registry.presentation.assertGuide(started.attemptId!, blue)).not.toThrow()
  expect(registry.presentation.pending(blue)).toEqual(before)
})


test('a guide read cannot return a now-hidden authored target after its asynchronous deciding observation is refused', async () => {
  const { registry, runtime, blueCall } = await setup()
  const source = await registry.compiledScenarioForRun(runtime.id)
  const guide = guideDefinitionSchema.parse({ id: 'async-visibility', title: 'Current picture', steps: [{ id: 'observe', title: 'Observe', instruction: 'Inspect the referenced unit',
    effects: [{ id: 'unit', target: { kind: 'object', objectId: 'unit:truck-1' }, action: { kind: 'highlight' } }],
    completion: { kind: 'condition', condition: { kind: 'observation', ref: 'unit:truck-1#pressure', operator: 'gt', value: 4, quantity: 'pressure', unit: 'MPa', maxAgeSeconds: 5 } },
  }] })
  const attempt = createGuideAttempt(guide, ['blue'], new Date().toISOString())
  let allowed = true
  const observedAt = runtime.snapshot().clock!.currentTime
  const readRuntime = { ...runtime,
    inspectionPolicy: () => ({ key: allowed ? 'allowed' : 'revoked', canInspect: () => allowed }),
    observations: () => ({
      declarations: async () => [{ objectId: 'unit:truck-1', revision: 'test', elements: [], observables: [{ ref: 'unit:truck-1#pressure', quantity: 'pressure', unit: 'MPa' }] }],
      read: async () => { allowed = false; return { observations: [{ ref: 'unit:truck-1#pressure', at: observedAt, clock: 'simulation', quality: 'good', value: 5 }], refused: [], unknown: [], leads: [] } },
    }),
  } as unknown as SimulationRunRuntime
  const readingRegistry = { ...registry, load: async () => readRuntime, loadedCompiledScenario: () => ({ ...source, guide }),
    guideFile: () => ({ read: async () => attempt, change: () => { throw new Error('A read never writes') } }),
  } as unknown as SimulationRunRegistry
  await expect(runGuideOperation('read', { attemptId: attempt.id }, { ...blueCall, registry: readingRegistry })).rejects.toMatchObject({ code: 'guide_step_unavailable' })
})


test('a saved attempt stays recoverable when its browser lease expires during the durable save', async () => {
  const { registry, runtime, blueCall } = await setup()
  let now = Date.now(), storedId: string | undefined
  const presentation = createPresentationDelivery(() => now)
  const recipient = presentation.register({ subject: { workspaceId: registry.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runtime.id } as never, clientId: 'slow-save', documentId: 'slow-save' }, ['blue'])
  const delayedRegistry: SimulationRunRegistry = { ...registry, presentation,
    guideFile: (runId, attemptId) => {
      const file = registry.guideFile(runId, attemptId)
      return { read: file.read, change: async apply => {
        const result = await file.change(current => {
          const changed = apply(current); storedId = changed.next.id; return changed
        })
        now += 61_000 // The durable write succeeded; its delivery offer was lost during that await.
        return result
      } }
    },
  }
  const sequence = runtime.snapshot().seq
  const result = await runGuideOperation('start', { recipient }, { ...blueCall, registry: delayedRegistry }) as { attemptId?: string; status?: string; problem?: string; step?: { effects: Array<{ delivery?: string }> } }
  expect(result.attemptId).toBe(storedId!)
  expect(result.status).toBe('active')
  expect(result.problem).toBeDefined()
  expect(result.step?.effects.every(effect => effect.delivery === 'unavailable')).toBe(true)
  expect((await registry.guideFile(runtime.id, storedId!).read())?.id).toBe(storedId!)
  expect(runtime.snapshot().seq).toBe(sequence) // A presentation retry cannot replay physical commands.
})
