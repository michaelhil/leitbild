import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRequestId, newWorkspaceId, presentationRecipientSchema, type WorkspaceId } from '@leitbild/contracts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { guideDefinitionSchema } from '../src/core/guides/model.ts'
import { guideReadingSchema } from '../src/core/guides/wire.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-guides-'))
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
  cleanup.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId()
  const request = new Request(`http://world.test/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
  expect((await handleWorldModuleApi(request, new URL(request.url), workspaces))?.status).toBe(201)
  const registry = workspaces.getLoaded(workspaceId)!.simulationRuns
  const source = {
    ...testScenarioDefinitions.find(source => source.id === 'test-response')!, id: 'guided-test',
    guide: guideDefinitionSchema.parse({ id: 'orientation', title: 'Learn the Run', startPaused: true,
      entry: { kind: 'clock', beforeSeconds: 1 }, steps: [
        { id: 'locate', title: 'Locate a unit', instruction: 'Observe the unit. Continue records acknowledgement, not understanding.',
          effects: [{ id: 'focus-unit', target: { kind: 'object', objectId: 'unit:a12' }, action: { kind: 'focus' } }], completion: { kind: 'acknowledge' } },
        { id: 'observe-time', title: 'Read actual simulation time', instruction: 'future-instructor-secret: advance the clock explicitly and inspect its result.',
          completion: { kind: 'condition', condition: { kind: 'clock', afterSeconds: 1 } } },
      ] }),
  }
  const revision = await registry.createScenario(source)
  const runtime = await registry.create({ scenarioId: source.id })
  return { workspaces, workspaceId, registry, runtime, source, revision }
}

const invoke = async (workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, operation: string, input: unknown, target: { resource?: unknown; definition?: unknown }, kind = 'human') => {
  const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${operation}/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      workspaceId, capabilityId: operation, ...target, input,
      access: { workspaceId, requestId: newRequestId(), actor: { kind, id: kind === 'ai' ? 'analyst' : 'learner' } },
    }),
  })
  const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
  if (response === null) throw new Error('The published World operation was not handled')
  return { status: response.status, body: await response.json() as any }
}

test('published guide operations persist honest learning evidence, restore it, and keep copy/reset independent', async () => {
  const { registry, workspaces, workspaceId, runtime } = await setup()
  const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runtime.id }
  const call = (suffix: string, input: unknown) => invoke(workspaces, workspaceId, `world.simulation-run.${suffix}`, input, { resource })
  expect(runtime.snapshot().clock?.paused).toBe(true)
  const registration = await call('presentation.register', { clientId: 'screen-a', documentId: 'doc-a' })
  const recipient = presentationRecipientSchema.parse(registration.body.result)
  const start = await call('guide.start', { recipient })
  expect(start.status).toBe(200)
  const first = guideReadingSchema.parse(start.body.result)
  expect(first.step?.id).toBe('locate')
  expect(JSON.stringify(first)).not.toContain('future-instructor-secret')
  const pending = await call('presentation.poll', { recipient })
  expect(pending.body.result.requests).toHaveLength(1)
  const effect = first.step!.effects[0]!
  const recorded = await call('guide.receipt', { attemptId: first.attemptId, stepAttemptId: first.stepAttemptId,
    effectId: effect.id, recipient, receipt: { requestId: effect.requestId, documentId: recipient.documentId, status: 'applied', at: new Date().toISOString() } })
  const shown = guideReadingSchema.parse(recorded.body.result)
  expect(shown.step?.id).toBe('locate')
  expect(shown.completed).toEqual([])
  const next = await call('guide.advance', { attemptId: shown.attemptId, expectedRevision: shown.revision, recipient, action: 'next' })
  const second = guideReadingSchema.parse(next.body.result)
  expect(second.completed?.[0]?.outcome).toBe('acknowledged')
  expect(second.condition?.status).toBe('contradicted')
  const refused = await call('guide.advance', { attemptId: second.attemptId, expectedRevision: second.revision, recipient, action: 'next' })
  expect(refused.body.error.code).toBe('guide_condition_unmet')
  await registry.advanceExecution(runtime.id, { minutes: 0.02 })
  const finish = await call('guide.advance', { attemptId: second.attemptId, expectedRevision: second.revision, recipient, action: 'next' })
  const completed = guideReadingSchema.parse(finish.body.result)
  expect(completed.status).toBe('completed')
  expect(completed.completed?.[1]?.outcome).toBe('satisfied')
  expect(completed.completed?.[1]?.evidence?.value).toBeGreaterThanOrEqual(1)
  const copy = await registry.copy(runtime.id, {})
  expect(await registry.guideFile(copy.id, completed.attemptId!).read()).toBeNull()
  const copiedResource = { ...resource, id: copy.id }
  const copyRegistration = await invoke(workspaces, workspaceId, 'world.simulation-run.presentation.register', { clientId: 'copy', documentId: 'copy-doc' }, { resource: copiedResource })
  const incompatible = await invoke(workspaces, workspaceId, 'world.simulation-run.guide.start', { recipient: copyRegistration.body.result }, { resource: copiedResource })
  expect(incompatible.body.error.code).toBe('guide_entry_unmet')
  await registry.close(runtime.id)
  const restored = await call('guide.read', { attemptId: completed.attemptId })
  expect(restored.body.result.status).toBe('completed')
  expect(restored.body.result.completed).toEqual(completed.completed)
  await registry.reset(runtime.id)
  expect(await registry.guideFile(runtime.id, completed.attemptId!).read()).toBeNull()
  const late = await call('guide.receipt', { attemptId: first.attemptId, stepAttemptId: first.stepAttemptId, effectId: effect.id, recipient,
    receipt: { requestId: effect.requestId, documentId: recipient.documentId, status: 'applied', at: new Date().toISOString() } })
  expect(late.status).toBe(409)
})

test('AI reads omit future guide source and ordinary updates preserve hidden human-authored material', async () => {
  const { registry, workspaces, workspaceId, runtime, source, revision } = await setup()
  const definition = { workspaceId, moduleId: 'world', type: 'world.scenario', id: source.id, revisionId: revision.id }
  const read = await invoke(workspaces, workspaceId, 'world.scenario.read', {}, { definition }, 'ai')
  expect(read.status).toBe(200)
  expect(JSON.stringify(read.body)).not.toContain('future-instructor-secret')
  expect(read.body.result.source).not.toHaveProperty('guide')
  expect(read.body.result.source).not.toHaveProperty('timeline')
  const update = await invoke(workspaces, workspaceId, 'world.scenario.update', { source: { ...read.body.result.source, title: 'Edited safe title' } }, { definition }, 'ai')
  expect(update.status).toBe(200)
  expect((await registry.currentScenario(source.id))?.document.guide).toEqual(source.guide)
  const current = (await registry.currentScenario(source.id))!
  const replacement = await invoke(workspaces, workspaceId, 'world.scenario.update', { source: { ...current.document, guide: { ...source.guide, title: 'Replace protected source' } } }, { definition: { ...definition, revisionId: current.id } }, 'ai')
  expect(replacement.body.error.code).toBe('scenario_script_hidden')
  // AI cannot register a receiver in order to impersonate a learner or choose another browser.
  const forbidden = await invoke(workspaces, workspaceId, 'world.simulation-run.presentation.register', { clientId: 'ai', documentId: 'fake' }, { resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runtime.id } }, 'ai')
  expect(forbidden.body.error.code).toBe('presentation_receiver_for_people')
})
