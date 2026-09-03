import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { createSimulationRunRegistry } from '../../core/simulation-runs/registry.ts'
import { createScenarioRuntimeResolver } from '../../core/scenarios/runtime-resolver.ts'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../../core/scenarios/authoring.ts'
import { scenarioDefinitionSchema } from '../../core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { createSituationMonitorRuntimeAdapter } from './runtime.ts'
import { situationMonitorPack } from './pack.ts'
import { situationStatusSchema, situationCapabilities } from './capabilities.ts'
import { situationSourceSchema } from './model.ts'
import type { ActorId } from '../../core/model/index.ts'

test('monitor-only Run uses native compilation, persists edits, isolates siblings and restores without physical objects', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-situation-runtime-'))
  const workspaceId = newWorkspaceId(), packs = [situationMonitorPack]
  const source = scenarioDefinitionSchema.parse({ id: 'monitor', title: 'Worldwide', packs: [{ id: 'situation-monitor', config: {} }], world: { startsAt: '2026-09-03T00:00:00.000Z' }, view: { map: { center: [139,35], zoom: 3 } } })
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, scenarioDefinitions: [source], runtimeAdapters: [createSituationMonitorRuntimeAdapter()], scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }), compileScenarioDefinition: source => compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs) })
  const actor = { id: 'actor:test' as ActorId, label: 'Test', role: 'operator' as const }
  try {
    const first = await registry.create({ scenarioId: 'monitor' }), second = await registry.create({ scenarioId: 'monitor' })
    expect(first.snapshot().objects).toEqual([])
    await expect(registry.createAcceleratedCopy(first.id, { minutes: 1 }))
      .rejects.toMatchObject({ code: 'acceleration_unsupported' })
    const source = situationSourceSchema.parse({ id: 'media', name: 'Configured but paused', adapter: 'media', format: 'video', url: 'https://example.com/video.mp4', enabled: false })
    const result = await first.invokeCapability(actor, { capabilityId: 'world.situation-monitor.configuration.replace', input: { expectedRevision: 0, config: { sources: [source] } } })
    expect(result.kind).toBe('command'); if (result.kind === 'command') expect(result.result.ok).toBe(true)
    const conflict = await first.invokeCapability(actor, { capabilityId: 'world.situation-monitor.configuration.replace', input: { expectedRevision: 0, config: {} } })
    if (conflict.kind === 'command') expect(conflict.result.ok).toBe(false)
    const sibling = await second.invokeCapability(actor, { capabilityId: 'world.situation-monitor.status', input: {} })
    expect(situationStatusSchema.parse(sibling.result).config.sources).toEqual([])
    await registry.close(first.id)
    const restored = await registry.load(first.id)
    const response = await restored.invokeCapability(actor, { capabilityId: 'world.situation-monitor.status', input: {} })
    expect(situationStatusSchema.parse(response.result)).toMatchObject({ revision: 1, config: { sources: [source] }, sources: [{ state: 'paused' }] })
    expect(restored.snapshot().objects).toEqual([])
    await registry.delete(second.id)
    expect((await restored.invokeCapability(actor, { capabilityId: 'world.situation-monitor.records.search', input: {} })).result).toMatchObject({ records: [], total: 0 })
    const missing = await restored.invokeCapability(actor, { capabilityId: 'world.situation-monitor.record.inspect', input: { sourceId: source.id, recordId: 'not-retained' } })
    expect(missing.result).toBeNull()
    expect(situationCapabilities.find(capability => capability.id === 'world.situation-monitor.record.inspect')!.output.parse(missing.result)).toBeNull()
    expect((await restored.invokeCapability(actor, { capabilityId: 'world.situation-monitor.record.inspect', input: { sourceId: 'removed-source', recordId: 'not-retained' } })).result).toBeNull()
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})
