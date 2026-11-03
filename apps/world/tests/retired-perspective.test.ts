import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, newRequestId, newWorkspaceId, workspaceResourceReferenceSchema, type WorkspaceResourceReference } from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { worldWorkspacePaths } from '../src/core/workspaces/paths.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import border from '../src/scenarios/halden-border-human-red.scenario.json'

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'world-retired-perspective-')), workspaceId = newWorkspaceId()
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const workspaces = createWorldWorkspaceRuntimeRegistry({
    dataDir: directory, moduleState: createWorldModuleState({ dataDir: directory }),
    runtimeAdapters: assembly.runtimeAdapters, workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: [],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
  })
  await workspaces.provision(workspaceId)
  const registry = (await workspaces.getOrLoad(workspaceId)).simulationRuns
  const source = scenarioDefinitionSchema.parse(border)
  await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
  const ref = (type: string, id: string) => workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type, id })
  const invoke = async (capabilityId: string, resource: WorkspaceResourceReference, input: unknown, actor: 'human' | 'ai' = 'human') => {
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: actor, id: `test-${actor}` } })
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId, resource, input, access }),
    })
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw Error('World did not handle its own invocation route')
    return { status: response.status, body: await response.json() as { result?: unknown; error?: { code: string } } }
  }
  const get = async (suffix: string) => {
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/${suffix}`)
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw Error('World did not handle its own metadata route')
    return await response.json() as unknown
  }
  return { directory, workspaceId, workspaces, registry, run, ref, invoke, get,
    close: async () => { await workspaces.shutdown(); await rm(directory, { recursive: true, force: true }) },
  }
}

test('retired Perspective operations are absent and guessed private references never become canonical Run access', async () => {
  const f = await fixture()
  try {
    expect(JSON.stringify(await f.get('capabilities'))).not.toContain('world.perspective.')
    const privateRef = f.ref('world.perspective', 'retained-private-admission')
    for (const actor of ['human', 'ai'] as const) {
      for (const operation of ['prepare', 'read', 'bind', 'revoke', 'discovery.read', 'context.read', 'objects.list', 'objects.read', 'observations.search', 'observations.read', 'presentation.register', 'presentation.poll', 'presentation.receipt', 'presentation.unregister', 'presentation.targets', 'presentation.request', 'presentation.result', 'presentation.cancel', 'presentation.verify']) {
        const response = await f.invoke(`world.perspective.${operation}`, privateRef, {}, actor)
        expect(response).toMatchObject({ status: 404, body: { error: { code: 'capability_not_found' } } })
      }
      await expect(f.invoke('world.simulation-run.inspect', privateRef, {}, actor)).rejects.toThrow('requires a world.simulation-run Resource')
    }
    const runRef = f.ref('world.simulation-run', f.run.id)
    expect(await f.invoke('world.simulation-run.inspect', runRef, {}, 'ai')).toMatchObject({ status: 403, body: { error: { code: 'ai_role_run_unsupported' } } })

    const restrictions = { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:blue-recce-1'), deny: ['inspect' as const] }] }
    expect(scenarioDefinitionSchema.safeParse({ ...border, agentRestrictions: restrictions }).success).toBe(false)
    await expect(f.run.setAgentRestrictions({ id: actorIdSchema.parse('actor:controller'), label: 'Controller', role: 'controller', roleIds: ['controller'] }, restrictions, 0)).rejects.toMatchObject({ code: 'agent_restrictions_in_role_run' })
  } finally { await f.close() }
})

test('normal discovery, Run reset/delete and Workspace reopening neither interpret nor rewrite retained private World files', async () => {
  const f = await fixture()
  try {
    const root = worldWorkspacePaths(f.directory, f.workspaceId).root
    const retained = join(root, 'perspectives'), admissions = join(retained, 'admissions'), runs = join(retained, 'runs')
    await mkdir(admissions, { recursive: true }); await mkdir(runs, { recursive: true })
    // Deliberately uninterpretable bytes prove this is preservation, not a hidden
    // legacy loader, state migration, repair or conversion into public Resources.
    const admission = '{"private-retention-sentinel":', incarnation = '{"id":"retained-incarnation"}\n'
    const admissionPath = join(admissions, 'retained-private-admission.json'), incarnationPath = join(runs, `${f.run.id}.json`)
    await writeFile(admissionPath, admission); await writeFile(incarnationPath, incarnation)
    expect(JSON.stringify(await f.get('resources'))).not.toContain('retained-private-admission')
    await f.registry.reset(f.run.id)
    await f.registry.delete(f.run.id)
    await f.workspaces.close(f.workspaceId)
    await f.workspaces.getOrLoad(f.workspaceId)
    expect(JSON.stringify(await f.get('resources'))).not.toContain('retained-private-admission')
    expect(JSON.stringify(await f.get('capabilities'))).not.toContain('world.perspective.')
    expect(await readFile(admissionPath, 'utf8')).toBe(admission)
    expect(await readFile(incarnationPath, 'utf8')).toBe(incarnation)
    expect(await readdir(admissions)).toEqual(['retained-private-admission.json'])
    expect(await readdir(runs)).toEqual([`${f.run.id}.json`])
  } finally { await f.close() }
})
