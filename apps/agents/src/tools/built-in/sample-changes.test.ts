import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createSampleChangesTool } from './utility-tools.ts'
import { createPassTool } from './agent-tools.ts'
import { createToolRegistry } from '../../core/tool-registry.ts'
import { buildToolSupport, createToolExecutor, effectiveAgentToolSelection } from '../../agents/spawn.ts'
import { createDeploymentRuntime } from '../../core/deployment-runtime.ts'
import { createAgentsModuleState } from '../../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry } from '../../core/workspaces/runtime-registry.ts'
import { handleAgentsModuleApi } from '../../api/workspace-module-api.ts'
import { toolRoutes } from '../../api/routes/tools.ts'
import type { RouteContext } from '../../api/routes/types.ts'
import { asAIAgent } from '../../agents/shared.ts'

const input = { timestamps: ['2026-07-12T04:01:10.043Z', '2026-07-12T04:01:15.043Z'], series: [{ key: 'sgB', unit: 'kg', values: [56933.65960980982, 56953.55986151602] }] }

test('real executor enforces selection and returns explicit input errors without accessing Room data', async () => {
  const registry = createToolRegistry()
  registry.register(createSampleChangesTool())
  const context = { callerId: 'analyst', callerName: 'Analyst' }
  const omitted = createToolExecutor(registry, [], context)
  expect(await omitted([{ tool: 'sample_changes', arguments: input }], 'world-room')).toMatchObject([{ success: false, error: expect.stringContaining('selection') }])
  const executor = createToolExecutor(registry, ['sample_changes'], context)
  const result = await executor([{ tool: 'sample_changes', arguments: input }], 'world-room')
  expect(result).toMatchObject([{ success: true, data: { inputsVerified: false, intervals: [{ elapsedSeconds: 5 }], series: [{ changes: [{ change: 19.900251706196286, ratePerSecond: 3.980050341239257 }] }] } }])
  const invalid = await executor([{ tool: 'sample_changes', arguments: { ...input, timestamps: [input.timestamps[0], input.timestamps[0]] } }], 'world-room')
  expect(invalid).toMatchObject([{ success: false, data: { code: 'invalid_tool_input', issues: [{ path: ['timestamps', 1] }] } }])
  expect(JSON.stringify(invalid)).toContain('strictly increasing')
})

test('default Assistant in a World-only Room exposes and executes nine tools, with ordinary profile inspection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-sample-changes-'))
  const previousHome = process.env.LEITBILD_HOME
  process.env.LEITBILD_HOME = directory
  const deployment = createDeploymentRuntime()
  deployment.sharedToolRegistry.register(createSampleChangesTool())
  deployment.sharedToolRegistry.register(createPassTool())
  for (const name of ['product_search', 'product_read', 'place_resolve']) {
    deployment.sharedToolRegistry.register({ name, description: name, parameters: { type: 'object' }, execute: async () => ({ success: true }) })
  }
  for (const name of ['leitbild-assistance', 'operator-displays', 'procedure-runner']) {
    deployment.sharedSkillStore.register({ name, description: name, body: 'Test fixture.', tools: [], allowedToolNames: [], dirPath: directory })
  }
  const state = createAgentsModuleState()
  const registry = createWorkspaceRuntimeRegistry({ deployment, moduleState: state, workspaceHostUrl: 'http://host.test' })
  const workspaceId = newWorkspaceId()
  const request = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, 'http://agents.test')
    const response = await handleAgentsModuleApi(new Request(url.href, { method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }), url, { state, registry })
    if (!response) throw new Error(`Unhandled Module path: ${path}`)
    return response
  }
  try {
    expect((await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })).status).toBe(201)
    const worldRun = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'world-run' })
    const scope = { kind: 'resource' as const, resource: worldRun }
    const capabilityId = 'agents.assistance.open'
    const opened = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      workspaceId, capabilityId, input: { scope },
      access: { workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'ai', id: 'operator', displayName: 'Operator' }, client: { kind: 'service', id: 'test' } },
    })
    expect(opened.status).toBe(201)
    const body = await opened.json() as { result: { resource: { id: string } } }
    const runtime = await registry.getOrLoad(workspaceId)
    const room = runtime.rooms.getRoom(body.result.resource.id)!
    const assistant = asAIAgent(room.getParticipantIds().map(id => runtime.team.getAgent(id)!).find(agent => agent.kind === 'ai')!)!
    expect(room.profile.scope).toEqual(scope)
    expect(assistant.getTools()).toContain('sample_changes')
    const support = await buildToolSupport(effectiveAgentToolSelection(assistant.getConfig()), runtime.toolRegistry, assistant, runtime.llm,
      roomId => roomId === room.profile.id ? room : undefined)
    expect(support.resolveToolDefinitions!(room.profile.id)!.map(tool => tool.function.name).sort()).toEqual([
      'conversation_read', 'pass', 'place_resolve', 'product_read', 'product_search', 'sample_changes', 'wiki_lookup', 'workspace_call', 'workspace_explore',
    ])
    const before = { messages: room.getRecent(100), scope: structuredClone(room.profile.scope), agents: runtime.team.listAgents().map(agent => agent.id) }
    const calculated = await support.toolExecutor!([{ tool: 'sample_changes', arguments: input }], room.profile.id)
    expect(calculated).toMatchObject([{ success: true, data: { inputsVerified: false, series: [{ changes: [{ change: 19.900251706196286 }] }] } }])
    expect({ messages: room.getRecent(100), scope: room.profile.scope, agents: runtime.team.listAgents().map(agent => agent.id) }).toEqual(before)

    const route = toolRoutes.find(route => route.method === 'GET' && route.pattern.test('/tools/sample_changes'))!
    const inspected = await route.handler(new Request('http://agents.test/tools/sample_changes'), '/tools/sample_changes'.match(route.pattern)!, { system: runtime } as RouteContext)
    expect(inspected.status).toBe(200)
    expect(await inspected.json()).toMatchObject({ name: 'sample_changes', parameters: createSampleChangesTool().parameters, source: { kind: 'built-in' }, enabledFor: [{ id: assistant.id }] })
  } finally {
    await registry.shutdown()
    if (previousHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
