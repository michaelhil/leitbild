import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly, worldPacks } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { validateWorldAssembly } from '../src/core/packs/assembly.ts'
import { describeScenarioAuthoring, scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

test('selected semantic discovery keeps broad tiers compact and reports owner lifecycle, units and compatible choices', () => {
  const catalog = scenarioAuthoringCatalogFor(worldPacks)
  for (const pack of catalog.packs) {
    const selected = { ...catalog, packs: [pack], commands: [] }
    const semantic = describeScenarioAuthoring(selected, 'semantic') as any
    expect(semantic.packs[0].configuration).toMatchObject({ beforeStart: expect.any(String), liveChanges: expect.any(String), requiresNewRevision: expect.any(String) })
    expect(semantic.packs[0].schema).toEqual(pack.configSchema)
    const compact = describeScenarioAuthoring(selected, 'catalog') as any
    expect(compact.packs[0]).not.toHaveProperty('configuration')
    expect(compact.packs[0]).not.toHaveProperty('configSchema')
    const machine = describeScenarioAuthoring(selected, 'authoring') as any
    expect(machine.packs[0].configSchema).toEqual(pack.configSchema)
    expect(machine.packs[0]).not.toHaveProperty('configFields')
  }
  const plant = { ...catalog, packs: catalog.packs.filter(pack => pack.id === 'process-plant'), commands: [] }
  const choice = (describeScenarioAuthoring(plant, 'semantic', { itemTypeId: 'plant', path: ['operatingPoint', 'ref'] }) as any).packs[0]
  expect(choice.fields[0].choices[0].compatibleWith.values).toContain('process-plant.pwr.reference')
  expect(choice.example).toBe('process-plant.pwr.full-power')
  const weather = { ...catalog, packs: catalog.packs.filter(pack => pack.id === 'weather'), commands: [] }
  const wind = (describeScenarioAuthoring(weather, 'semantic', { path: ['atmosphere', 'windDirectionDeg'] }) as any).packs[0]
  expect(wind.schema.description).toContain('FROM')
  expect(wind.example).toBe(240)
  expect(wind.fields[0].description).toContain('FROM')
  const ambulance = { ...catalog, packs: catalog.packs.filter(pack => pack.id === 'ambulance'), commands: [] }
  expect((describeScenarioAuthoring(ambulance, 'semantic', { itemTypeId: 'ambulance', path: ['basePosition', 0] }) as any).packs[0].schema.minimum).toBe(-180)
  expect(() => describeScenarioAuthoring(catalog, 'semantic')).toThrow('exactly one')
  expect(() => describeScenarioAuthoring(plant, 'semantic', { itemTypeId: 'missing' })).toThrow('Unknown authoring item type')
  expect(() => describeScenarioAuthoring(plant, 'semantic', { path: ['missing'] })).toThrow('Unknown authoring schema path')
})

test('owned pre-run model and exact Design capabilities work through the published Module API without connecting any runtime', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-cold-authoring-')), workspaceId = newWorkspaceId(), routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  let connections = 0
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    runtimeAdapters: assembly.runtimeAdapters.map(adapter => ({ ...adapter, connect: async config => { connections++; return adapter.connect(config) } })),
    workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: [],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
  })
  const invoke = async (capabilityId: string, input: unknown, actor: 'ai' | 'human') => {
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: actor, id: `discovery-${actor}` } })
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId, input, access }) })
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw Error('Module did not handle authoring discovery')
    return { status: response.status, body: await response.json() as any }
  }
  try {
    await workspaces.provision(workspaceId)
    for (const actor of ['human', 'ai'] as const) {
      const plant = await invoke('world.process-plant.models.describe', {}, actor)
      expect(plant.status).toBe(200)
      expect(plant.body.result.liveModelReplacement).toBe(false)
      expect(plant.body.result.models[0].parameters.properties.loopCount).toMatchObject({ minimum: 2, maximum: 6, description: expect.stringContaining('new Scenario Revision') })
      expect(plant.body.result.models[0].description).not.toContain('Validated')
      const designs = await invoke('world.physical-layout.designs.list', {}, actor)
      expect(designs.status).toBe(200)
      expect(designs.body.result.designs.map((row: { design: { revision: string } }) => row.design.revision)).toEqual(['pwr-full-unit-20261030-r10', 'pwr-campus-20261030-r12'])
      const exact = designs.body.result.designs[0].design
      const described = await invoke('world.physical-layout.design.describe', { design: exact }, actor)
      expect(described.status).toBe(200)
      expect(described.body.result).toMatchObject({ manifest: { design: exact }, liveDesignReplacement: false })
      expect(described.body.result.manifest).not.toHaveProperty('source')
      expect((await invoke('world.physical-layout.design.describe', { design: { ...exact, digest: '0'.repeat(64) } }, actor)).status).toBe(400)
      expect((await invoke('world.process-plant.models.describe', { modelRef: 'unknown' }, actor)).status).toBe(400)
      expect((await invoke('world.scenario-authoring.describe', { detail: 'semantic', packIds: ['drone'], selection: { path: ['stepIntervalMs'] } }, actor)).body.result.packs[0].schema.description).toContain('milliseconds')
      expect((await invoke('world.scenario-authoring.describe', { detail: 'semantic' }, actor)).status).toBe(400)
      expect((await invoke('world.scenario-authoring.describe', { detail: 'semantic', packIds: ['drone'], selection: { itemTypeId: 'missing' } }, actor)).status).toBe(400)
    }
    expect(connections).toBe(0)
  } finally { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
  const plantCapability = assembly.packs.find(pack => pack.descriptor.id === 'process-plant')!.workspaceCapabilities![0]!
  expect(() => validateWorldAssembly({ ...assembly, packs: assembly.packs.map(pack => pack.descriptor.id === 'physical-layout' ? { ...pack, workspaceCapabilities: [plantCapability] } : pack) })).toThrow('duplicate Workspace Capability')
  expect(() => validateWorldAssembly({ ...assembly, packs: assembly.packs.map(pack => pack.descriptor.id === 'physical-layout' ? { ...pack, workspaceCapabilities: [{ ...plantCapability, id: 'world.drone.foreign' }] } : pack) })).toThrow('not owned by its Pack')
})
