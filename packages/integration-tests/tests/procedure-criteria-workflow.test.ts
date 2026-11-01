import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createKnowledge } from '../../knowledge/src/index.ts'
import type { SimulationRunId } from '../../../apps/world/src/core/model/ids.ts'
import { createProcedureSourceService } from '../../../apps/world/src/features/procedures/source.ts'
import { loadSkills } from '../../../apps/agents/src/skills/loader.ts'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../../apps/agents/src/api/__fixtures__/stub-gateway.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import { createPlaceResolveTool, createProductKnowledgeTools, createSampleChangesTool } from '../../../apps/agents/src/tools/built-in/index.ts'
import type { AIAgent } from '../../../apps/agents/src/core/types/agent.ts'
import type { ChatRequest, StreamChunk } from '../../../apps/agents/src/core/types/llm.ts'
import {
  createWorkspaceRuntimeRegistry as createAgentsWorkspaceRuntimeRegistry,
  type WorkspaceRuntimeRegistry as AgentsWorkspaceRuntimeRegistry,
} from '../../../apps/agents/src/core/workspaces/runtime-registry.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation() })
const revision = 'e'.repeat(40)
const pressure = {
  type: 'comparison', tagId: 'PT-455', operator: '>', value: 12.7, unit: 'MPa', bound: 'value',
  evidence: 'engineering-diagnostic', source: '../systems/criteria.md#pressure', maxAgeSeconds: 0,
} as const
const manual = { type: 'manual', description: 'Local field confirmation is unestablished in this model.', tagIds: [], source: '../systems/criteria.md#manual' } as const
const decisions = (items: unknown) => `\`\`\`procedure-decisions\n${JSON.stringify(items)}\n\`\`\``
const tags = `## Tags
- id: PT-455
  description: Pressurizer model pressure
  units: MPa`
// Deliberately generic: this tests the real orchestration/authority chain, not qualification of E-0.
const entryProcedure = `---
type: procedure
procedure-md: 0.7
procedure-id: RUNNER-TEST
title: Guarded workflow fixture
---
## Step 1 [id: pressure-check]
Check: engineering pressure «PT-455» against the authored criterion.
${decisions([{ branchIndex: 0, condition: { type: 'not', condition: pressure } }, { branchIndex: 1, condition: pressure }])}
- Low → END
- Established → #local-confirmation
## Step 2 [id: local-confirmation]
Check: pressure «PT-455» AND local field confirmation.
${decisions([{ branchIndex: 0, condition: { type: 'all', conditions: [pressure, manual] } }])}
- Confirmed → [[RECOVERY-TEST]]
${tags}`
const recoveryProcedure = `---
type: procedure
procedure-md: 0.7
procedure-id: RECOVERY-TEST
title: Guarded recovery fixture
---
## Step 1 [id: monitor]
Check: engineering pressure «PT-455».
${decisions([{ branchIndex: 0, condition: pressure }])}
- Established → END
${tags}`

interface StepView {
  sequence: number
  run: { runId: string; procedureId: string; status: string; currentStepId?: string; driver?: { kind: string; actorId: string }; inputRequest?: { stepId: string; issue: string } }
  step?: { id: string; branchAssessments: Array<{ branchIndex: number; status: string; readings: unknown[]; reasons: string[] }> }
}
interface Receipt { ok: boolean; next: StepView }
interface CallResult { key: string; operationId: string; success: boolean; data?: unknown; error?: string; details?: unknown }
const json = async <T>(response: Response): Promise<T> => {
  expect(response.ok).toBe(true)
  return await response.json() as T
}
const until = async <T>(read: () => T | undefined): Promise<T> => {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('Procedure continuation did not arrive')
    await Bun.sleep(25)
  }
}

describe('guarded procedure workflow through real Host, Agents and World Modules', () => {
  test('unsupported decisions reach the model and Inspector, hold for input, and resume the exact transferred Run without placekeeping bypass', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'procedure-criteria-world-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'procedure-criteria-ui-'))
    const leitbildHome = await mkdtemp(join(tmpdir(), 'procedure-criteria-agents-'))
    await writeFile(join(uiDir, 'embed.html'), 'embed page')
    const originalLeitbildHome = process.env.LEITBILD_HOME
    process.env.LEITBILD_HOME = leitbildHome
    let agentsRegistry: AgentsWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await agentsRegistry?.shutdown()
      if (originalLeitbildHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = originalLeitbildHome
      for (const dir of [leitbildHome, dataDir, uiDir]) await rm(dir, { recursive: true, force: true })
    })

    const knowledge = createKnowledge({ revision, documents: [
      { path: 'procedures/RUNNER-TEST.md', content: entryProcedure },
      { path: 'procedures/RECOVERY-TEST.md', content: recoveryProcedure },
      { path: 'systems/criteria.md', content: '# Criteria\n## Pressure\nThis fixture tests model engineering pressure, not instrument qualification.\n## Manual\nA local field confirmation is not established by this model.' },
    ] })
    const worldRegistry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
      procedureSourceService: createProcedureSourceService({
        sources: [{ sourceId: 'guarded-fixture', label: 'Guarded workflow fixture', repository: 'test', ref: 'publication', procedurePath: 'procedures' }],
        retentionDirectory: join(dataDir, 'procedure-publications'), loadKnowledge: async () => knowledge,
      }),
    })
    const worldServer = createWorldServer({ workspaces: worldRegistry, featuredDefinitions: { definitions: [], listed: [] }, bindHost: '127.0.0.1', port: 0, uiDistPath: uiDir, mapArtifacts: { rootDir: join(dataDir, 'maps') } })
    cleanup.push(() => worldServer.stop())
    const agentsState = createAgentsModuleState()
    const agentsServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!agentsRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
        return await handleAgentsModuleApi(request, new URL(request.url), { state: agentsState, registry: agentsRegistry }) ?? new Response('Not found', { status: 404 })
      },
    })
    cleanup.push(() => agentsServer.stop(true))
    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [
          moduleRegistrationSchema.parse({ moduleId: 'world', internalBaseUrl: `http://127.0.0.1:${worldServer.port}`, manifestPath: '/.well-known/workspace-module' }),
          moduleRegistrationSchema.parse({ moduleId: 'agents', internalBaseUrl: `http://127.0.0.1:${agentsServer.port}`, manifestPath: '/.well-known/workspace-module' }),
        ],
      }),
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`


    const requests: ChatRequest[] = []
    let phase = 0, procedureRunId = ''
    const scriptErrors: unknown[] = []
    const resultOf = (request: ChatRequest): CallResult => {
      const message = request.messages.findLast(message => message.role === 'tool')
      if (!message) throw new Error('Expected the actual previous tool result')
      const evidence = JSON.parse(message.content) as { execution: { turnId: string; toolCallId: string; part: string }; result: { results: CallResult[] } }
      expect(evidence.execution).toMatchObject({ turnId: expect.any(String), toolCallId: expect.any(String), part: 'result' })
      const result = evidence.result.results[0]!
      if (!result) throw new Error(`Missing result: ${message.content}`)
      return result
    }
    const viewOf = (result: CallResult): StepView => {
      expect(result.success).toBe(true)
      const data = result.data as Receipt | StepView
      return 'next' in data ? data.next : data
    }
    const call = (operationId: string, input: unknown, say?: string): StreamChunk => ({
      delta: '', done: true, finishReason: 'tool_calls', tokensUsed: { prompt: 1, completion: 1 },
      toolCalls: [{ id: `phase-${phase}`, function: { name: 'workspace_call', arguments: { calls: [
        { key: 'step', operationId, input, ...(say === undefined ? {} : { say }) },
      ] } } }],
    })
    const answer = (text: string): ReadonlyArray<StreamChunk> => [{ delta: text, done: false }, { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }]
    const gateway = {
      ...makeStubGateway(),
      stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
        requests.push(structuredClone(request))
        try {
          switch (phase++) {
            case 0:
              // Dynamic discovery and implicit Resource selection use the current Room Scope.
              yield call('world.procedure.runs.list', {}); break
            case 1:
              expect(JSON.stringify(resultOf(request))).toContain(procedureRunId)
              yield call('world.procedure.run.drive', { runId: procedureRunId, action: 'claim' }); break
            case 2:
              expect(viewOf(resultOf(request)).run).toMatchObject({ runId: procedureRunId, currentStepId: 'pressure-check', driver: { kind: 'ai' } })
              // An unsupported model assertion with no manual citations cannot establish this branch.
              yield call('world.procedure.run.transition', { runId: procedureRunId, stepId: 'pressure-check', branchIndex: 0, basis: 'Test attack: declare low pressure despite the current criterion.', evidenceTagIds: [] }, 'UNACCEPTED pressure decision'); break
            case 3:
              expect(resultOf(request)).toMatchObject({ success: false, error: expect.stringContaining('procedure_branch_not_supported') })
              expect(JSON.stringify(resultOf(request).details)).toContain('contradicted')
              yield call('world.procedure.run.step.read', { runId: procedureRunId }); break
            case 4: {
              const current = viewOf(resultOf(request))
              expect(current.run.currentStepId).toBe('pressure-check')
              expect(current.step!.branchAssessments.map(item => item.status)).toEqual(['contradicted', 'supported'])
              yield call('world.procedure.run.transition', { runId: procedureRunId, stepId: 'pressure-check', branchIndex: 1, basis: 'Model engineering pressure satisfies its authored comparison; not an instrument qualification.', evidenceTagIds: ['PT-455'] }, 'Unit A1 · RUNNER-TEST/1 · model pressure established → local confirmation'); break
            }
            case 5:
              expect(viewOf(resultOf(request)).run.currentStepId).toBe('local-confirmation')
              yield call('world.procedure.run.transition', { runId: procedureRunId, stepId: 'pressure-check', branchIndex: 1, basis: 'Test attack: reuse a stale previous-step decision.', evidenceTagIds: ['PT-455'] }, 'UNACCEPTED stale step decision'); break
            case 6:
              expect(resultOf(request).success).toBe(false)
              expect(resultOf(request).error).toContain('current')
              yield call('world.procedure.run.step.read', { runId: procedureRunId }); break
            case 7:
              expect(viewOf(resultOf(request)).run.currentStepId).toBe('local-confirmation')
              expect(viewOf(resultOf(request)).step!.branchAssessments[0]!.status).toBe('unknown')
              yield call('world.procedure.run.transition', { runId: procedureRunId, stepId: 'local-confirmation', branchIndex: 0, basis: 'Test attack: pressure established; local confirmation not observable, nevertheless normal.', evidenceTagIds: ['PT-455'] }, 'UNACCEPTED partial AND decision'); break
            case 8:
              expect(resultOf(request)).toMatchObject({ success: false, error: expect.stringContaining('procedure_branch_not_supported') })
              expect(JSON.stringify(resultOf(request).details)).toContain('unknown')
              yield call('world.procedure.run.request-input', { runId: procedureRunId, stepId: 'local-confirmation', issue: 'Local field confirmation is unestablished. Confirm it or retain this hold; pressure alone is insufficient.' }, 'Unit A1 · RUNNER-TEST/2 · local field confirmation unknown; operator input needed'); break
            case 9:
              expect(viewOf(resultOf(request)).run.inputRequest?.stepId).toBe('local-confirmation')
              yield* answer('Held RUNNER-TEST step 2: local field confirmation is unestablished; pressure alone cannot establish its AND criterion.'); break
            case 10:
              expect(request.messages.at(-1)!.content).toContain('Continue delegated procedure RECOVERY-TEST')
              yield call('world.procedure.run.step.read', {}); break
            case 11: {
              const current = viewOf(resultOf(request))
              expect(current.run).toMatchObject({ procedureId: 'RECOVERY-TEST', currentStepId: 'monitor', driver: { kind: 'ai' } })
              expect(current.run.runId).not.toBe(procedureRunId)
              expect(current.step!.branchAssessments[0]!.status).toBe('supported')
              yield call('world.procedure.run.transition', { runId: current.run.runId, stepId: 'monitor', branchIndex: 0, basis: 'Model engineering pressure satisfies the authored comparison.', evidenceTagIds: ['PT-455'] }, 'Unit A1 · RECOVERY-TEST/1 · model pressure established → END'); break
            }
            case 12:
              expect((resultOf(request).data as Receipt).ok).toBe(true)
              yield call('world.procedure.runs.list', {}); break
            case 13: {
              const runs = (resultOf(request).data as { runs: Array<{ runId: string; procedureId: string; status: string }> }).runs
              expect(runs.find(run => run.runId === procedureRunId)?.status).toBe('transferred')
              expect(runs.find(run => run.procedureId === 'RECOVERY-TEST')?.status).toBe('completed')
              yield* answer('RECOVERY-TEST reached END after the operator supplied the local judgement. RUNNER-TEST transferred; this does not establish its unmodeled field criterion.'); break
            }
            default: throw new Error(`Unexpected model call ${phase}`)
          }
        } catch (error) { scriptErrors.push(error); throw error }
      },
    }
    const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
    await loadSkills(join(import.meta.dir, '../../../apps/agents/skills'), deployment.sharedSkillStore, deployment.sharedToolRegistry)
    deployment.sharedToolRegistry.registerAll(createProductKnowledgeTools())
    deployment.sharedToolRegistry.register(createPlaceResolveTool())
    deployment.sharedToolRegistry.register(createSampleChangesTool())
    agentsRegistry = createAgentsWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: baseUrl, idleMs: 1_000_000 })
    const { workspace } = await json<{ workspace: { id: string } }>(await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Guarded procedure workflow' }),
    }))
    const invoke = async <T>(capabilityId: string, body: Record<string, unknown>): Promise<T> =>
      (await json<{ result: T }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))).result
    const { definitions } = await json<{ definitions: Array<{ ref: Record<string, string>; currentRevisionId: string }> }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`))
    const scenario = definitions.find(definition => definition.ref.type === 'world.scenario' && definition.ref.id === 'test-plant')!
    const started = await invoke<{ id: string }>('world.scenario.start', { definition: { ...scenario.ref, revisionId: scenario.currentRevisionId }, input: {} })
    const resources = workspaceResourceCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)).json()).resources
    const resource = resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === started.id)!
    const operator = { kind: 'human', id: 'operator', displayName: 'Operator' }
    await invoke('world.simulation-run.execution.set', { resource: resource.ref, input: { playback: 'paused' }, actor: operator })
    const plantId = 'plant:halden-a1'
    // A person starts and works a Run, then asks the Assistant to take it over.
    const initial = await invoke<{ pinned: { runId: string } }>('world.procedure.run.start', { resource: resource.ref, input: { procedureId: 'RUNNER-TEST', scope: { plantId, label: 'Unit A1' } }, actor: operator })
    procedureRunId = initial.pinned.runId
    const opened = await invoke<{ resource: { id: string } }>('agents.assistance.open', { input: { scope: { kind: 'resource', resource: resource.ref }, title: resource.title }, actor: operator })
    const agentsRuntime = await agentsRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const room = agentsRuntime.rooms.getRoom(opened.resource.id)!
    const assistant = room.getParticipantIds().map(id => agentsRuntime.team.getAgent(id)).find(agent => agent?.kind === 'ai') as AIAgent
    assistant.updateModel('mock-model')
    const person = await agentsRuntime.spawnHumanAgent({ name: 'Operator' }, () => {})
    await agentsRuntime.addAgentToRoom(person.id, room.profile.id, 'test')
    agentsRuntime.routeMessage({ rooms: [room.profile.id] }, { senderId: person.id, senderName: 'Operator', content: 'Take over and continue RUNNER-TEST on unit A1.', type: 'chat' })
    await assistant.whenIdle()
    expect(scriptErrors).toEqual([])
    const held = room.getRetainedMessages().find(message => message.senderId === assistant.id && message.type === 'chat' && message.content.startsWith('Held'))!
    expect(held).toBeDefined()
    const current = await invoke<StepView>('world.procedure.run.step.read', { resource: resource.ref, input: { runId: procedureRunId }, actor: operator })
    expect(current.run).toMatchObject({ status: 'active', currentStepId: 'local-confirmation', inputRequest: { stepId: 'local-confirmation' } })
    expect(current.step!.branchAssessments[0]!.status).toBe('unknown')
    expect(requests).toHaveLength(10)

    // An explicit human judgement is recorded as such; it is not fabricated AI evidence.
    await invoke('world.procedure.run.transition', { resource: resource.ref, input: { runId: procedureRunId, stepId: 'local-confirmation', branchIndex: 0, basis: 'Operator judgement for the test; no model proof of local confirmation.' }, actor: operator })
    const continued = await until(() => room.getRetainedMessages().find(message => message.cause?.name === 'procedure input answered'))
    await assistant.whenIdle()
    expect(scriptErrors).toEqual([])
    expect(continued.senderId).toBe(assistant.id)
    expect(continued.inReplyTo?.[0]).toBe(held.id)
    expect(continued.content).toContain('RECOVERY-TEST reached END')
    expect(requests).toHaveLength(14)
    const state = worldRegistry.getLoaded(workspaceIdSchema.parse(workspace.id))!.simulationRuns.get(started.id as SimulationRunId)!
    const snapshot = state.snapshot()
    const runs = snapshot.procedures!.runs
    expect(runs.find(run => run.runId === procedureRunId)).toMatchObject({ sourceId: 'guarded-fixture', sourceRevision: revision, status: 'transferred', scope: { plantId } })
    expect(runs.find(run => run.procedureId === 'RECOVERY-TEST')).toMatchObject({ sourceRevision: revision, status: 'completed', scope: { plantId } })
    const branchEvents = state.events().filter(event => event.type === 'procedure.branch.selected')
    expect(branchEvents).toHaveLength(3)
    expect(branchEvents[0]).toMatchObject({ stepId: 'pressure-check', branchIndex: 1, selectedBy: `actor:ai:${assistant.id}`, criterion: { status: 'supported', readings: [{ tagId: 'PT-455', evidence: 'engineering-diagnostic', provenance: 'runtime-model', writable: false, unit: 'MPa', modelDigest: expect.any(String), sampledAt: expect.any(String) }] } })
    expect(branchEvents[1]).toMatchObject({ stepId: 'local-confirmation', branchIndex: 0, selectedBy: 'actor:human:operator', criterion: { status: 'unknown' } })
    expect(branchEvents[2]).toMatchObject({ stepId: 'monitor', targetKind: 'end', selectedBy: `actor:ai:${assistant.id}`, criterion: { status: 'supported' } })
    const chat = room.getRetainedMessages().map(message => message.content).join('\n')
    expect(chat).not.toContain('UNACCEPTED')
    expect(chat).toContain('model pressure established → local confirmation')
    expect(chat).toContain('local field confirmation unknown; operator input needed')
    expect(chat).toContain('model pressure established → END')
    const turns = agentsRuntime.executionStore.listTurns(room.profile.id)
    expect(turns).toHaveLength(2)
    const calls = turns.flatMap(turn => agentsRuntime.executionStore.listCalls(room.profile.id, turn.id).map(summary => agentsRuntime.executionStore.getCall(room.profile.id, turn.id, summary.id)!))
    expect(calls).toHaveLength(12)
    for (const call of calls) {
      expect(JSON.stringify(call.arguments)).not.toMatch(/world\.procedure\.(step\.update|run\.(close|reset))/)
      expect(JSON.stringify(call.arguments)).not.toContain('"target"')
      for (const result of (call.result?.data as { results: CallResult[] }).results) {
        if (result.success) expect(JSON.stringify(result)).toContain(started.id)
      }
    }
    const refused = calls.filter(call => JSON.stringify(call.result).includes('procedure_branch_not_supported'))
    expect(refused).toHaveLength(2)
    expect(calls.filter(call => JSON.stringify(call.result).includes('current step'))).toHaveLength(1)
    for (const call of refused) expect(JSON.stringify(call.result)).toContain('assessment')
    expect(turns.reduce((count, turn) => count + agentsRuntime.executionStore.modelEvidence(room.profile.id, turn.id).models.length, 0)).toBe(requests.length)
    expect(requests[0]!.systemBlocks!.map(block => block.text).join('\n')).toContain('step.branchAssessments')
  }, 60_000)
})
