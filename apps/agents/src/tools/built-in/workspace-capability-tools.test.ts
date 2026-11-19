import { describe, expect, test } from 'bun:test'
import {
  capabilityIdSchema,
  moduleIdSchema,
  newWorkspaceId,
  workspaceDefinitionCatalogSchema,
  workspaceDefinitionReferenceSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceCatalogSchema,
  workspaceResourceReferenceSchema,
  type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { createContextPublisherLookup, createViewPublisherLookup, createWorkspaceCapabilityTools, resolveScope, workspaceCallResultForModel } from './workspace-capability-tools.ts'
import { toolsToDefinitions } from '../../llm/tool-capability.ts'
import { createTurnCards } from '../../agents/answer-cards.ts'
import { collectViewRefs, evaluate } from '../../agents/evaluation.ts'
import type { LLMProvider } from '../../core/types/llm.ts'

const workspaceId = newWorkspaceId()
const moduleId = moduleIdSchema.parse('world')
const readId = capabilityIdSchema.parse('world.simulation-run.read')
const writeId = capabilityIdSchema.parse('world.simulation-run.write')
const inspectDefinitionId = capabilityIdSchema.parse('world.scenario.inspect')
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-01' })
const otherRun = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-02' })
const family = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.run-family', id: 'family-01' })
const definition = workspaceDefinitionRevisionReferenceSchema.parse({
  workspaceId, moduleId, type: 'world.scenario', id: 'scenario-01', revisionId: 'revision-01',
})
const runTarget = { kind: 'resource' as const, ref: run }
const now = new Date().toISOString()

const catalogFetch = (requests: Request[]): typeof fetch => (async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  requests.push(request)
  const pathname = new URL(request.url).pathname
  if (pathname.endsWith('/resources')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    resources: [
      { ref: run, title: 'Run 01', capabilityIds: [readId, writeId], links: [{ rel: 'member-of', ref: family }], summary: [], observedAt: now },
      { ref: otherRun, title: 'Run 02', capabilityIds: [readId], links: [{ rel: 'member-of', ref: family }], summary: [], observedAt: now },
      { ref: family, title: 'Run family', capabilityIds: [], links: [{ rel: 'contains', ref: run }, { rel: 'contains', ref: otherRun }], summary: [], observedAt: now },
    ],
  })
  if (pathname.endsWith('/definitions')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    definitions: [{
      ref: { workspaceId, moduleId, type: definition.type, id: definition.id },
      title: 'Scenario 01', currentRevisionId: definition.revisionId,
      capabilityIds: [inspectDefinitionId], inspectionCapabilityId: inspectDefinitionId,
    }],
  })
  if (pathname.endsWith('/capabilities')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    capabilities: [
      { id: readId, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'Read run', description: 'Read current live simulation state and time.', searchTerms: ['status report sitrep'], risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      { id: writeId, moduleId, kind: 'command', scope: { kind: 'resource', resourceType: run.type }, title: 'Change run', description: 'Change the live simulation.', searchTerms: ['trip reactor coolant pumps RCPs'], risk: 'write', idempotent: false, acceptsIdempotencyKey: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      { id: inspectDefinitionId, moduleId, kind: 'query', scope: { kind: 'definition', definitionType: definition.type }, title: 'Inspect scenario', description: 'Read a scenario definition.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    ],
  })
  return Response.json({ result: { state: 'running' } })
}) as typeof fetch

const makeTools = (scope: WorkspaceRoomScope, requests: Request[] = []) => createWorkspaceCapabilityTools({
  workspaceId,
  hostBaseUrl: 'https://host.test',
  getRoomScope: roomId => roomId === 'room' ? scope : undefined,
  fetchImpl: catalogFetch(requests),
})

const context = { callerId: 'agent', callerName: 'Analyst', roomId: 'room' }
const comparisonKey = (ref: { workspaceId: string; moduleId: string; type: string; id: string }) => `${ref.workspaceId}:${ref.moduleId}:${ref.type}:${ref.id}`
const comparisonContext = {
  ...context,
  comparison: { resourceKeys: [comparisonKey(run)], definitionKeys: [comparisonKey(definition)], messageIds: [], turnIds: [] },
}

describe('Workspace progressive-discovery tools', () => {
  test('trusted invocation effects use published risk and exact resolved targets, without claiming attainment', async () => {
    const [, call] = makeTools({ kind: 'resource', resource: run })
    const read = await call!.execute({ calls: [{ key: 'r', operationId: readId, input: {} }] }, context)
    const write = await call!.execute({ calls: [{ key: 'w', operationId: writeId, input: { demand: 42 } }] }, context)
    expect(read.effects).toEqual([{ kind: 'read', outcome: 'returned', operationId: readId, target: runTarget }])
    expect(write.effects).toEqual([{ kind: 'change', outcome: 'returned', operationId: writeId, target: runTarget }])
    expect(workspaceCallResultForModel(write, createTurnCards()).effects).toEqual(write.effects)
  })

  test('a successful batch envelope preserves an individually refused invocation as not dispatched', async () => {
    const requests: Request[] = [], [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    const result = await call!.execute({ calls: [
      { key: 'inside', operationId: readId, target: runTarget, input: {} },
      { key: 'outside', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} },
    ] }, context)
    expect(result.success).toBe(true)
    expect(result.effects).toEqual([
      { kind: 'read', outcome: 'returned', operationId: readId, target: runTarget },
      { kind: 'read', outcome: 'not-dispatched', operationId: readId, target: { kind: 'resource', ref: otherRun } },
    ])
    expect(requests.filter(request => request.url.endsWith('/invoke'))).toHaveLength(1)
  })

  for (const mode of ['transport', 'refusal', 'server-error', 'missing-result'] as const) {
    test(`a dispatched change with ${mode} retains uncertainty rather than claiming no side effect`, async () => {
      let invocations = 0
      const base = catalogFetch([])
      const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
        if (!request.url.endsWith('/invoke')) return base(request)
        invocations++
        if (mode === 'transport') throw new Error('Connection lost after dispatch')
        if (mode === 'missing-result') return Response.json({ received: true })
        return Response.json({ error: { code: 'operation_refused', message: 'No successful result' } }, { status: mode === 'refusal' ? 409 : 502 })
      }) as typeof fetch
      const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl })
      const result = await call!.execute({ calls: [{ key: 'w', operationId: writeId, target: runTarget, input: {}, say: 'Changed.' }] }, context)
      expect(invocations).toBe(1)
      expect(result).toMatchObject({ success: true, data: { results: [{ success: false }] }, effects: [{ kind: 'change', outcome: 'unknown', operationId: writeId, target: runTarget }] })
      expect(result).not.toHaveProperty('progress')
    })
  }

  test('comparison discovery and invocation stay inside the captured read-only target set', async () => {
    const requests: Request[] = []
    const [explore, call] = makeTools({ kind: 'workspace' }, requests)
    const discovered = await explore!.execute({ view: 'scope' }, comparisonContext)
    expect(discovered).toMatchObject({ success: true, data: { resources: [{ target: runTarget, operationCount: 1, links: [] }] } })
    expect(JSON.stringify(discovered)).not.toContain('Run 02')
    expect(await explore!.execute({ view: 'operations', operationIds: [readId, writeId] }, comparisonContext))
      .toMatchObject({ success: true, data: { operations: [{ operationId: readId }] } })
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, comparisonContext))
      .toMatchObject({ success: true, data: { results: [{ success: true }] } })
    const writes = await call!.execute({ calls: [{ key: 'w', operationId: writeId, target: runTarget, input: {} }] }, comparisonContext)
    expect(writes).toMatchObject({ success: true, data: { results: [{ success: false }] } })
    const outside = await call!.execute({ calls: [{ key: 'outside', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, comparisonContext)
    expect(outside).toMatchObject({ success: true, data: { results: [{ success: false }] } })
    const invoked = requests.filter(request => new URL(request.url).pathname.endsWith('/invoke'))
    expect(invoked).toHaveLength(1)
    expect(invoked[0]!.url).toContain(readId)
  })

  test('comparison family membership cannot grow with a later copy', async () => {
    const [explore, call] = makeTools({ kind: 'collection', collection: family, members: { mode: 'all', except: [] } })
    const captured = { ...comparisonContext, comparison: { ...comparisonContext.comparison, resourceKeys: [comparisonKey(family), comparisonKey(run)], definitionKeys: [] } }
    const discovered = await explore!.execute({ view: 'scope', resourceType: run.type }, captured)
    expect(discovered).toMatchObject({ success: true, data: { resources: [{ target: runTarget }] } })
    expect(JSON.stringify(discovered)).not.toContain('Run 02')
    const familyResult = await explore!.execute({ view: 'scope', resourceType: family.type }, captured)
    expect(JSON.stringify(familyResult)).not.toContain('run-02')
    expect(await call!.execute({ calls: [{ key: 'late', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, captured))
      .toMatchObject({ success: true, data: { results: [{ success: false }] } })
  })

  test('comparison fails explicitly when captured access is revoked', async () => {
    const [explore, call] = makeTools({ kind: 'resource', resource: otherRun })
    const found = await explore!.execute({ view: 'scope' }, comparisonContext)
    expect(found).toMatchObject({ success: false })
    expect(JSON.stringify(found)).toContain('comparison_scope_changed')
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, comparisonContext))
      .toMatchObject({ success: false })
  })

  test('comparison detects deleted targets even when the Room still holds their references', async () => {
    const base = catalogFetch([])
    const [explore] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/resources')) return response
        const body = await response.json() as { resources: Array<{ ref: { id: string } }> }
        body.resources = body.resources.filter(resource => resource.ref.id !== run.id)
        return Response.json(body)
      }) as typeof fetch,
    })
    const result = await explore!.execute({}, { ...comparisonContext, comparison: { ...comparisonContext.comparison, definitionKeys: [] } })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('comparison_scope_changed')
  })

  test('comparison-withheld read operations cannot be discovered or invoked', async () => {
    const requests: Request[] = []
    const base = catalogFetch(requests)
    const [explore, call] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/capabilities')) return response
        const body = await response.json() as { capabilities: Array<{ id: string; comparisonUnavailableReason?: string }> }
        body.capabilities.find(operation => operation.id === readId)!.comparisonUnavailableReason = 'Contains conversation data outside the captured history.'
        return Response.json(body)
      }) as typeof fetch,
    })
    expect(await explore!.execute({ view: 'operations', operationIds: [readId] }, comparisonContext))
      .toMatchObject({ success: true, data: { operations: [] } })
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, comparisonContext))
      .toMatchObject({ success: true, data: { results: [{ success: false }] } })
    expect(requests.some(request => new URL(request.url).pathname.endsWith('/invoke'))).toBe(false)
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: true }] } })
  })

  test('revalidates cached operations and replaces them when catalog content changes', async () => {
    const base=catalogFetch([])
    let version=1
    const statuses:number[]=[]
    const tools=createWorkspaceCapabilityTools({workspaceId,hostBaseUrl:'https://host.test',getRoomScope:()=>({kind:'workspace'}),
      fetchImpl:(async(input,init)=>{
        const request=new Request(String(input),init)
        if(!request.url.endsWith('/capabilities'))return base(input,init)
        const etag='"'+version+'"'
        if(request.headers.get('if-none-match')===etag){statuses.push(304);return new Response(null,{status:304})}
        const response=await base(input,init)
        const body=await response.json() as {capabilities:Array<{id:string}>}
        if(version===2)body.capabilities=body.capabilities.filter(c=>c.id!==readId)
        statuses.push(200)
        return Response.json(body,{headers:{etag}})
      }) as typeof fetch})
    const query=()=>tools[0]!.execute({view:'operations',operationIds:[readId]},context)
    expect(await query()).toMatchObject({success:true,data:{operations:[{operationId:readId}]}})
    await query()
    version=2
    expect(await query()).toMatchObject({success:true,data:{operations:[]}})
    expect(statuses).toEqual([200,304,200])
  })
  test('filters all result kinds and operations consistently', async () => {
    const [explore] = makeTools({kind:'workspace'})
    expect(await explore!.execute({view:'operations',definitionType:definition.type},context)).toMatchObject({
      success:true,data:{resources:[],operations:[{operationId:inspectDefinitionId}]},
    })
    expect(await explore!.execute({view:'operations',resourceType:run.type,operationIds:[inspectDefinitionId]},context))
      .toMatchObject({success:true,data:{operations:[]}})
  })

  test('pins source revisions while leaving revision existence to the owning Module', async () => {
    const requests: Request[]=[]
    const base=catalogFetch(requests)
    const tools=createWorkspaceCapabilityTools({
      workspaceId,hostBaseUrl:'https://host.test',getRoomScope:()=>({kind:'resource',resource:run}),
      fetchImpl:(async(input,init)=>{
        const response=await base(input,init)
        const url=String(input)
        if(url.endsWith('/resources')){
          const body=await response.json() as {resources:Array<{sourceDefinition?:typeof definition}>}
          body.resources[0]!.sourceDefinition=definition
          return Response.json(body)
        }
        if(url.endsWith('/definitions')){
          const body=await response.json() as {definitions:Array<{currentRevisionId:string}>}
          body.definitions[0]!.currentRevisionId='revision-new'
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
    expect(await tools[0]!.execute({},context)).toMatchObject({success:true,data:{
      definitions:[{target:{ref:definition}}],
    }})
    const invoke=(revisionId:string)=>tools[1]!.execute({calls:[{key:'source',operationId:inspectDefinitionId,
      target:{kind:'definition',ref:{...definition,revisionId}},input:{}}]},context)
    expect(await invoke(definition.revisionId)).toMatchObject({success:true,data:{results:[{success:true}]}})
    expect(await invoke('revision-new')).toMatchObject({success:true,data:{results:[{success:false,error:expect.stringContaining('target_out_of_scope')}]}})
  })

  test('rejects duplicate batch keys before executing', async () => {
    const requests:Request[]=[]
    const [,call]=makeTools({kind:'workspace'},requests)
    expect(await call!.execute({calls:[1,2].map(()=>({key:'same',operationId:readId,target:runTarget,input:{}}))},context))
      .toMatchObject({success:false,error:expect.stringContaining('unique')})
    expect(requests).toHaveLength(0)
  })
  test('exposes only the two generic tools', () => {
    expect(makeTools({ kind: 'workspace' }).map(tool => tool.name)).toEqual(['workspace_explore', 'workspace_call'])
  })

  test('explores compact Resources and exact operation schemas inside Room Scope', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const scope = await explore!.execute({ view: 'scope' }, context)
    expect(scope).toMatchObject({ success: true, data: {
      scope: { kind: 'resource', resource: run }, total: 1,
      resources: [{ target: runTarget, operationCount: 2 }],
    } })

    const operations = await explore!.execute({
      view: 'operations', target: runTarget, operationIds: [readId], includeInputSchema: true,
    }, context)
    expect(operations).toMatchObject({ success: true, data: {
      operations: [{ operationId: readId, inputSchema: { type: 'object' } }],
    } })
  })

  test('finds Pack-owned vocabulary without exposing search metadata as authority', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const result = await explore!.execute({
      view: 'operations', target: runTarget, queries: ['trip unit 2 RCPs'],
    }, context)
    expect(result).toMatchObject({ success: true, data: {
      operations: [{ operationId: writeId, matchedTerms: ['trip', 'rcps'] }],
    } })
    expect((result.data as { operations: Array<Record<string, unknown>> }).operations[0]).not.toHaveProperty('searchTerms')
  })

  test('keeps browsing compact and returns requested schemas directly with a focused search', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const broad = await explore!.execute({
      view: 'operations', queries: ['simulation'],
    }, context)
    for (const operation of (broad.data as { operations: Array<Record<string, unknown>> }).operations) {
      expect(operation).not.toHaveProperty('inputSchema')
      expect(operation).not.toHaveProperty('outputSchema')
    }

    const focused = await explore!.execute({
      view: 'operations', queries: ['sitrep'], includeInputSchema: true,
    }, context)
    expect(focused).toMatchObject({ success: true, data: {
      total: 1, operations: [{ operationId: readId, inputSchema: { type: 'object' } }],
    } })
    expect(focused.data).not.toHaveProperty('schemaGuidance')
    expect((focused.data as { operations: unknown[] }).operations[0]).not.toHaveProperty('outputSchema')

    const exact = await explore!.execute({
      view: 'operations', operationIds: [readId], includeInputSchema: true, includeOutputSchema: true,
    }, context)
    expect(exact).toMatchObject({ success: true, data: {
      operations: [{ operationId: readId, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
    } })
  })

  test('operation pagination is independent of large Resource inventories', async () => {
    const base = catalogFetch([])
    const [explore] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/resources')) return response
        const body = await response.json() as { resources: Array<{ ref: typeof run }> }
        const original = body.resources[0]!
        body.resources = Array.from({ length: 60 }, (_, index) => ({ ...original, ref: workspaceResourceReferenceSchema.parse({ ...run, id: `run-${index}` }) }))
        return Response.json(body)
      }) as typeof fetch,
    })
    expect(await explore!.execute({ view: 'scope' }, context)).toMatchObject({ success: true, data: { returned: 30, hasMore: true } })
    expect(await explore!.execute({ view: 'operations', queries: ['simulation'], limit: 1, includeInputSchema: true }, context))
      .toMatchObject({ success: true, data: { total: 2, returned: 1, hasMore: true, resources: [], definitions: [], operations: [{ inputSchema: { type: 'object' } }] } })
    expect(await explore!.execute({ view: 'operations', queries: ['simulation'], offset: 1, limit: 1 }, context))
      .toMatchObject({ success: true, data: { total: 2, returned: 1, hasMore: false } })
    expect(await explore!.execute({ view: 'all' }, context)).toMatchObject({ success: false, error: expect.stringContaining('invalid_tool_input') })
  })

  // A Pack's many operations share the words of its namespace: World's
  // process-plant ids all read world, process, plant.
  const packCatalogTools = () => {
    const nouns = ['plants', 'signals', 'alarms', 'controls', 'components', 'actions', 'credibility', 'catalog', 'graph', 'display', 'assessments', 'conditions']
    const verbs = ['list', 'search', 'read', 'evaluate', 'compose', 'view', 'propose']
    const packOperations = nouns.flatMap(noun => verbs.map(verb => ({
      id: capabilityIdSchema.parse(`world.process-plant.${noun}.${verb}`), moduleId, kind: 'query' as const,
      scope: { kind: 'resource' as const, resourceType: run.type },
      title: `${noun} · ${verb}`, description: `Process Plant ${noun}: ${verb} them for one Plant of the Run.`,
      risk: 'read' as const, idempotent: true,
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { plantId: { type: 'string' } } },
      outputSchema: { type: 'object' },
    })))
    const base = catalogFetch([])
    return createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        const path = new URL(String(input)).pathname
        if (path.endsWith('/capabilities')) {
          const body = await response.json() as { capabilities: unknown[] }
          body.capabilities.push(...packOperations)
          return Response.json(body)
        }
        if (path.endsWith('/resources')) {
          const body = await response.json() as { resources: Array<{ ref: typeof run; capabilityIds: string[] }> }
          body.resources[0]!.capabilityIds.push(...packOperations.map(operation => operation.id))
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
  }
  const operationIdsOf = (result: Awaited<ReturnType<NonNullable<ReturnType<typeof makeTools>[0]>['execute']>>) =>
    (result.data as { operations: Array<{ operationId: string }> }).operations.map(operation => operation.operationId)

  test('an operation id passed as a query is that exact operation, never its namespace words matched against every operation', async () => {
    const [explore] = packCatalogTools()
    const ids = ['world.process-plant.plants.list', 'world.process-plant.signals.search', 'world.process-plant.signals.read', 'world.process-plant.display.compose', 'world.process-plant.assessments.evaluate']
    const result = await explore!.execute({ view: 'operations', queries: ids, includeInputSchema: true }, context)
    expect(result).toMatchObject({ success: true, data: { total: 5, returned: 5, hasMore: false } })
    expect(operationIdsOf(result).sort()).toEqual([...ids].sort())
    expect(result.data).not.toHaveProperty('unavailableOperationIds')
    // The same as asking for them by operationIds.
    expect(await explore!.execute({ view: 'operations', operationIds: ids, includeInputSchema: true }, context)).toEqual(result)
  })

  test('an exact id this Room cannot reach is named, not answered with a word search', async () => {
    const [explore] = packCatalogTools()
    const result = await explore!.execute({ view: 'operations', queries: ['world.process-plant.plant.list', 'world.process-plant.signals.read'] }, context)
    expect(result).toMatchObject({ success: true, data: { total: 1, unavailableOperationIds: ['world.process-plant.plant.list'] } })
    expect(operationIdsOf(result)).toEqual(['world.process-plant.signals.read'])
  })

  test('each plain-language query gets its best match first, by the words that tell operations apart', async () => {
    const [explore] = packCatalogTools()
    // Namespace words every operation shares rank nothing; the page takes
    // every query's best match before any query's second best.
    const result = await explore!.execute({ view: 'operations', queries: ['world process plant plants list', 'world process plant signals search', 'process plant display compose'], limit: 3 }, context)
    expect(operationIdsOf(result)).toEqual(['world.process-plant.plants.list', 'world.process-plant.signals.search', 'world.process-plant.display.compose'])
    expect(result).toMatchObject({ success: true, data: { hasMore: true } })
  })

  test('a page carrying schemas holds a focused search by default, and always every exact id asked for', async () => {
    const [explore] = packCatalogTools()
    const focused = await explore!.execute({ view: 'operations', queries: ['process plant signals'], includeInputSchema: true }, context)
    expect(focused).toMatchObject({ success: true, data: { returned: 5, hasMore: true } })
    const compact = await explore!.execute({ view: 'operations', queries: ['process plant signals'] }, context)
    expect(compact).toMatchObject({ success: true, data: { returned: 30, hasMore: true } })
    const verbs = ['list', 'search', 'read', 'evaluate', 'compose', 'view', 'propose'].map(verb => `world.process-plant.signals.${verb}`)
    const exact = await explore!.execute({ view: 'operations', operationIds: verbs, queries: ['alarms'], includeInputSchema: true }, context)
    expect(exact).toMatchObject({ success: true, data: { returned: 7, hasMore: true } })
    expect(operationIdsOf(exact).sort()).toEqual([...verbs].sort())
    // The schema the model reads keeps every constraint, without the dialect URI.
    expect((exact.data as { operations: Array<{ inputSchema: unknown }> }).operations[0]!.inputSchema).toEqual({ type: 'object', properties: { plantId: { type: 'string' } } })
  })

  test('a Room reaches the display publishers its Scope holds, as their Module marks them, never by id', async () => {
    const compose = capabilityIdSchema.parse('world.process-plant.display.compose')
    const base = catalogFetch([])
    const lookup = (scope: WorkspaceRoomScope, publishes: boolean) => createViewPublisherLookup({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined,
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        const path = new URL(String(input)).pathname
        if (path.endsWith('/capabilities')) {
          const body = await response.json() as { capabilities: unknown[] }
          body.capabilities.push({ id: compose, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'display · compose', description: 'Compose a display.', risk: 'read', idempotent: true, ...(publishes ? { publishes: ['embedded-view'] } : {}), inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })
          return Response.json(body)
        }
        if (path.endsWith('/resources')) {
          // Only Run 01 offers the display operation.
          const body = await response.json() as { resources: Array<{ ref: typeof run; capabilityIds: string[] }> }
          body.resources.find(resource => resource.ref.id === run.id)!.capabilityIds.push(compose)
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
    expect(await lookup({ kind: 'workspace' }, true)('room')).toEqual([compose])
    expect(await lookup({ kind: 'resource', resource: run }, true)('room')).toEqual([compose])
    expect(await lookup({ kind: 'resource', resource: otherRun }, true)('room')).toEqual([])
    expect(await lookup({ kind: 'workspace' }, false)('room')).toEqual([])
    expect(lookup({ kind: 'workspace' }, true)('missing')).rejects.toThrow('has no valid scope')
  })

  test('a Room\'s context publishers are the Resources in its Scope whose operation is marked context, read as the Agent', async () => {
    const contextId = capabilityIdSchema.parse('world.simulation-run.context')
    const base = catalogFetch([])
    const invoked: Array<{ path: string; body: Record<string, unknown> }> = []
    const lookup = (scope: WorkspaceRoomScope) => createContextPublisherLookup({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined,
      fetchImpl: (async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
        const path = new URL(request.url).pathname
        if (path.endsWith('/invoke')) {
          invoked.push({ path, body: await request.json() as Record<string, unknown> })
          return Response.json({ result: { context: { text: 'Run 01 · PAUSED', at: now, clock: 'simulation' } } })
        }
        const response = await base(input, init)
        if (path.endsWith('/capabilities')) {
          const body = await response.json() as { capabilities: unknown[] }
          body.capabilities.push({ id: contextId, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'context', description: 'Run context.', risk: 'read', idempotent: true, publishes: ['context'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })
          return Response.json(body)
        }
        if (path.endsWith('/resources')) {
          const body = await response.json() as { resources: Array<{ ref: typeof run; capabilityIds: string[] }> }
          for (const resource of body.resources) if (resource.ref.type === run.type) resource.capabilityIds.push(contextId)
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
    expect(await lookup({ kind: 'workspace' }).publishers('room')).toEqual([{ operationId: contextId, resource: run }, { operationId: contextId, resource: otherRun }])
    expect(await lookup({ kind: 'resource', resource: otherRun }).publishers('room')).toEqual([{ operationId: contextId, resource: otherRun }])
    expect(await lookup({ kind: 'resource', resource: family }).publishers('room')).toEqual([])
    const read = await lookup({ kind: 'workspace' }).read({ operationId: contextId, resource: run }, { id: 'agent-1', name: 'Assistant' })
    expect(read).toEqual({ ok: true, context: { text: 'Run 01 · PAUSED', at: now, clock: 'simulation' } })
    expect(invoked[0]).toEqual({ path: `/api/workspaces/${workspaceId}/capabilities/${contextId}/invoke`, body: { resource: run, input: {}, actor: { kind: 'ai', id: 'agent-1', displayName: 'Assistant' } } })
  })

  test('publisher discovery uses the current Room scope after a delayed catalog read', async () => {
    for (const next of [{ kind: 'resource' as const, resource: otherRun }, undefined]) {
      let scope: WorkspaceRoomScope | undefined = { kind: 'resource', resource: run }
      const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      let readers = 0
      const base = catalogFetch([])
      const fetchImpl = (async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/resources')) {
          if (++readers === 2) reached.resolve()
          await release.promise
        }
        const response = await base(input, init)
        if (!path.endsWith('/capabilities')) return response
        const body = await response.json() as { capabilities: Array<Record<string, unknown>> }
        return Response.json({ ...body, capabilities: body.capabilities.map(operation => ({ ...operation,
          ...(operation.id === readId ? { publishes: ['context'] } : operation.id === writeId ? { publishes: ['embedded-view'] } : {}),
        })) })
      }) as typeof fetch
      const deps = { workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => scope, fetchImpl }
      const contexts = createContextPublisherLookup(deps).publishers('room')
      const views = createViewPublisherLookup(deps)('room')
      const outcomes = Promise.allSettled([contexts, views])
      await reached.promise
      scope = next
      release.resolve()
      if (next === undefined) {
        const results = await outcomes
        expect(results.every(result => result.status === 'rejected' && String(result.reason).includes('has no valid scope'))).toBe(true)
      } else {
        expect(await contexts).toEqual([{ operationId: readId, resource: otherRun }])
        expect(await views).toEqual([])
        await outcomes
      }
    }
  })

  test('essential discovery and action semantics reach the actual native model schema', () => {
    const [explore, call] = toolsToDefinitions(makeTools({ kind: 'workspace' }))
    const properties = explore!.function.parameters.properties as Record<string, { description?: string }>
    expect(properties.queries!.description).toContain('not asset names or live state')
    expect(properties.includeInputSchema!.description).toContain('focused search')
    const calls = (call!.function.parameters.properties as Record<string, { description?: string }>).calls!
    expect(calls.description).toContain('not an atomic snapshot')
  })

  test('resolves collection membership live and honors exclusions', async () => {
    const [explore] = makeTools({
      kind: 'collection', collection: family, members: { mode: 'all', except: [otherRun] },
    })
    const result = await explore!.execute({ view: 'scope' }, context)
    const ids = ((result.data as { resources: Array<{ target: { ref: { id: string } } }> }).resources)
      .map(resource => resource.target.ref.id)
    expect(ids).toEqual(['run-01', 'family-01'])
  })

  test('calls reads and changes through one shape while enforcing Room Scope', async () => {
    const [, call] = makeTools({ kind: 'resource', resource: run })
    expect(await call!.execute({ calls: [{ key: 'inferred', operationId: readId, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'inferred', success: true, data: { state: 'running' } }] } })
    expect(await call!.execute({ calls: [{ key: 'state', operationId: readId, target: runTarget, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'state', operationId: readId, success: true, data: { state: 'running' } }] } })

    expect(await call!.execute({ calls: [{ key: 'other', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })

    const [, ambiguousCall] = makeTools({ kind: 'collection', collection: family, members: { mode: 'all', except: [] } })
    expect(await ambiguousCall!.execute({ calls: [{ key: 'ambiguous', operationId: readId, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_required') }] } })
  })

  test('completes a published view with the invoked Resource and offers it by reference only', async () => {
    const view = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state: '{"composition":{}}' }
    const viewFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (new URL(request.url).pathname.endsWith('/invoke')) return Response.json({ result: { view, shows: ['trend'] } })
      return catalogFetch([])(input, init)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: viewFetch })
    const recorded = await call!.execute({ calls: [{ key: 'pressure display', operationId: readId, input: {} }] }, { ...context, executionCallId: 'call_2_0' })
    expect(recorded).toMatchObject({ success: true, data: { results: [{
      key: 'pressure display',
      viewRef: 'call_2_0/pressure%20display',
      embeddedView: { ...view, moduleId: 'world', subject: run },
    }] } })
    const standalone = await call!.execute({ calls: [{ key: 'p', operationId: readId, input: {} }] }, context)
    expect(standalone).toMatchObject({ success: true, data: { results: [{ viewError: expect.stringContaining('no execution evidence') }] } })
  })

  test('retains a discovered Planning schedule publication and offers its exact view reference to the model', async () => {
    const plan = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'planning', type: 'planning.plan', id: 'plan-1' })
    const operationId = 'planning.plan.display'
    const view = { viewType: 'planning.schedule', title: 'Finish by 18:00', height: 650, state: '{"plan":"plan-1","option":"deadline-18"}' }
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith('/resources')) return Response.json({ workspaceId, modules: [{ moduleId: 'planning', status: 'ready' }], resources: [{ ref: plan, title: 'Maintenance plan', capabilityIds: [operationId], links: [], summary: [], observedAt: now }] })
      if (pathname.endsWith('/capabilities')) return Response.json({ workspaceId, modules: [{ moduleId: 'planning', status: 'ready' }], capabilities: [{ id: operationId, moduleId: 'planning', kind: 'query', scope: { kind: 'resource', resourceType: plan.type }, title: 'Show schedule', description: 'Show a checked option and requested deadline.', risk: 'read', idempotent: true, publishes: ['embedded-view'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] })
      if (pathname.endsWith('/invoke')) return Response.json({ result: { view, schedule: { status: 'validated feasible', finish: '2026-11-18T15:00:00.000Z' } } })
      return catalogFetch([])(input, init)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: plan }), fetchImpl })
    const recorded = await call!.execute({ calls: [{ key: 'schedule', operationId, input: { option: 'deadline-18' } }] }, { ...context, executionCallId: 'call_2_0' })
    const refs = new Set<string>()
    collectViewRefs(refs, 'workspace_call', recorded)
    expect([...refs]).toEqual(['call_2_0/schedule'])
    expect(recorded).toMatchObject({ success: true, data: { results: [{ embeddedView: { ...view, moduleId: 'planning', subject: plan }, viewRef: 'call_2_0/schedule' }] } })
    const shown = workspaceCallResultForModel(recorded, createTurnCards())
    expect(shown).toMatchObject({ data: { results: [{ viewRef: 'call_2_0/schedule', data: { schedule: { status: 'validated feasible' } } }] } })
    expect(JSON.stringify(shown)).not.toContain('"state"')
  })

  test('a decision receipt stays actionable while its owner-published evidence locator remains opaque', async () => {
    const source = { sourceId: 'source-1', sourceRevision: 'revision-1', sourcePath: 'procedures/example.md' }
    const locator = { runId: 'procedure-1', ...source, eventId: 'event-7', sequence: 7, commandId: 'command-1' }
    const decision = {
      run: { runId: 'procedure-1', procedureId: 'example', ...source, scope: { objectId: 'plant:unit-2' } },
      event: { id: 'event-7', simulationRunId: run.id, seq: 7, runId: 'procedure-1', stepId: '4', branchIndex: 0, target: '5', targetKind: 'step', simulationTime: '2026-01-01T12:00:00.000Z', selectedBy: 'ai', criterionStatus: 'supported' },
    }
    const view = { viewType: 'procedure.decision', title: 'Recorded step decision', height: 640, state: JSON.stringify(locator), windowOnly: true }
    const invocations: string[] = []
    const receiptFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (new URL(request.url).pathname.endsWith('/invoke')) {
        invocations.push(request.url)
        return Response.json({ result: { ok: true, decision, view } })
      }
      return catalogFetch([])(input, init)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: receiptFetch })
    const raw = await call!.execute({ calls: [{ key: 'step', operationId: writeId, input: {}, say: 'Step 4 verified' }] }, { ...context, executionCallId: 'call_4_0' })
    const before = JSON.stringify(raw)
    const shown = workspaceCallResultForModel(raw, createTurnCards())
    const [entry] = (shown.data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(entry).toMatchObject({ success: true, data: { ok: true, decision } })
    expect(entry).not.toHaveProperty('viewRef')
    expect(entry!.data).not.toHaveProperty('view')
    const viewRefs = new Set<string>()
    collectViewRefs(viewRefs, 'workspace_call', raw)
    expect(viewRefs.size).toBe(0)
    expect(JSON.stringify(shown.data)).not.toContain('state')
    expect(JSON.stringify(shown.data)).not.toContain('sequence')
    expect(JSON.stringify(shown.data)).not.toContain('criterionReadings')
    expect(JSON.stringify(shown.data)).not.toContain('command-1')
    expect(entry).not.toHaveProperty('embeddedView')
    // The Inspector still resolves the exact owner-published view from the
    // immutable result; Agents does not request its proof while evaluating.
    expect((raw.data as { results: ReadonlyArray<unknown> }).results[0]).toMatchObject({ embeddedView: { ...view, subject: run, moduleId: 'world' } })
    expect(JSON.stringify(raw)).toBe(before)
    expect(invocations).toHaveLength(1)
    // This diagnostic window is not an answer display. The ordinary loop
    // must accept its plain answer without a forced view fence or retry.
    let passes = 0
    const corrections: unknown[] = []
    const provider: LLMProvider = {
      models: async () => ['fixture'],
      chat: async () => {
        passes++
        if (passes > 2) throw new Error('Unexpected extra model round for diagnostic evidence')
        return passes === 1
          ? { content: '', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 }, toolCalls: [{ function: { name: 'workspace_call', arguments: { calls: [{ key: 'step', operationId: writeId, input: {} }] } } }] }
          : { content: 'Step 4 verified; continuing to step 5.', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }
      },
    }
    const evaluated = await evaluate({ messages: [{ role: 'user', content: 'Continue the procedure' }], flushInfo: { ids: new Set<string>(), triggerRoomId: 'room' }, warnings: [] },
      { name: 'Tester', model: 'fixture', persona: 'Run the procedure.' }, provider, async () => [raw], undefined, 'room',
      { onEvent: event => { if (event.kind === 'correction') corrections.push(event) } })
    expect(evaluated.decision.response).toEqual({ action: 'respond', content: 'Step 4 verified; continuing to step 5.' })
    expect(passes).toBe(2)
    expect(corrections).toEqual([])
  })

  test('a window-only view (a dashboard\'s board) is kept as evidence a cited line opens, with no viewRef, and the model reads no view (R4 §2.6)', async () => {
    const board = { viewType: 'display.dashboard', title: 'Whole Run · dashboard', height: 960, state: '{"scope":"run"}', windowOnly: true }
    const card = { at: { at: '2026-01-01T10:16:00.000Z', clock: 'simulation' }, more: 0, adjusted: [], items: [{ key: 'k1', label: 'Unit One · speed', reading: '93.2 %', numbers: [{ value: 93.2, decimals: 1 }], at: 'Unit One' }] }
    const boardFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (new URL(request.url).pathname.endsWith('/invoke')) return Response.json({ result: { scope: 'run', view: board, card } })
      return catalogFetch([])(input, init)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: boardFetch })
    const raw = await call!.execute({ calls: [{ key: 'board', operationId: readId, input: {} }] }, { ...context, executionCallId: 'call_1_0' })
    const [entry] = (raw.data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(entry).toMatchObject({ key: 'board', embeddedView: { ...board, moduleId: 'world', subject: run } })
    expect(entry).not.toHaveProperty('viewRef')
    expect(entry).not.toHaveProperty('viewError')
    const viewRefs = new Set<string>()
    collectViewRefs(viewRefs, 'workspace_call', raw)
    expect(viewRefs.size).toBe(0)
    const [shown] = (workspaceCallResultForModel(raw, createTurnCards()).data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(shown).toEqual({ key: 'board', operationId: readId, target: runTarget, success: true, data: { scope: 'run', card: ['card at 2026-01-01T10:16:00.000Z (simulation)', 'k1 · Unit One · speed · 93.2 %'] } })
  })

  test('the model reads a view by reference: its opaque state and envelope stay in the execution evidence', async () => {
    const state = JSON.stringify({ composition: { title: 'Pressure', panels: [{ kind: 'trend', signals: ['PZR-P'] }] }, issuedAt: now })
    const view = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state }
    const viewFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (!new URL(request.url).pathname.endsWith('/invoke')) return catalogFetch([])(input, init)
      const { input: asked } = await request.json() as { input: { display?: true } }
      return Response.json({ result: asked.display === true ? { view, shows: ['trend'] } : { state: 'running' } })
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: viewFetch })
    const raw = await call!.execute({ calls: [
      { key: 'display', operationId: readId, input: { display: true } },
      { key: 'plain', operationId: readId, input: {} },
      { key: 'refused', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} },
    ] }, { ...context, executionCallId: 'call_0_0' })
    const before = JSON.stringify(raw)
    const shown = workspaceCallResultForModel(raw, createTurnCards())
    // The raw result, which the execution store and every check read, keeps the view.
    expect(JSON.stringify(raw)).toBe(before)
    expect((raw.data as { results: ReadonlyArray<unknown> }).results[0]).toMatchObject({ embeddedView: { state }, data: { view: { state } } })
    const [display, plain, refused] = (shown.data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(display).toEqual({
      key: 'display', operationId: readId, target: runTarget, success: true, viewRef: 'call_0_0/display',
      data: { view: { viewType: 'process-plant.display', title: 'Pressure', height: 340 }, shows: ['trend'] },
    })
    expect(JSON.stringify(shown)).not.toContain('composition')
    const [, rawPlain, rawRefused] = (raw.data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(plain).toBe(rawPlain)
    expect(refused).toBe(rawRefused)
    const failed = { success: false, error: 'invalid_tool_input: Batch keys must be unique', data: { code: 'invalid_tool_input' } }
    expect(workspaceCallResultForModel(failed, createTurnCards())).toBe(failed)
  })

  test('a card reads as its lines; each further card of the turn is re-keyed from the last key + 1; a broken card fails loudly', () => {
    const at = { at: '2026-01-01T10:16:00.000Z', clock: 'simulation' as const }
    const card = (labels: ReadonlyArray<string>) => ({ at, more: 0, adjusted: [], items: labels.map((label, index) => ({ key: `k${index + 1}`, label, reading: `${index + 1}.0 %`, numbers: [{ value: index + 1, decimals: 1 }] })) })
    const vignette = (key: string, labels: ReadonlyArray<string>) => ({ key, operationId: readId, success: true, data: { view: { viewType: 'display.vignette', title: 'Loading', height: 240, state: '{}' }, card: card(labels) }, embeddedView: {}, viewRef: `call_0_0/${key}` })
    const cards = createTurnCards()
    const first = workspaceCallResultForModel({ success: true, data: { results: [vignette('a', ['Line A · loading', 'Line B · loading'])] } }, cards)
    const second = workspaceCallResultForModel({ success: true, data: { results: [{ key: 'b', operationId: readId, success: true, data: { card: card(['Reserve']) } }] } }, cards)
    expect((first.data as { results: ReadonlyArray<unknown> }).results[0]).toEqual({
      key: 'a', operationId: readId, success: true, viewRef: 'call_0_0/a',
      data: { view: { viewType: 'display.vignette', title: 'Loading', height: 240 }, card: ['card at 2026-01-01T10:16:00.000Z (simulation)', 'k1 · Line A · loading · 1.0 %', 'k2 · Line B · loading · 2.0 %'] },
    })
    expect((second.data as { results: ReadonlyArray<{ data: unknown }> }).results[0]!.data).toEqual({ card: ['card at 2026-01-01T10:16:00.000Z (simulation)', 'k3 · Reserve · 1.0 %'] })
    // The turn's map holds every line by the key the model read it under.
    expect(cards.items().map(item => `${item.key} ${item.label}`)).toEqual(['k1 Line A · loading', 'k2 Line B · loading', 'k3 Reserve'])
    expect(() => workspaceCallResultForModel({ success: true, data: { results: [{ key: 'c', operationId: readId, success: true, data: { card: { items: 'none' } } }] } }, cards)).toThrow()
  })

  test('a refusal of input that does not match the schema carries the schema, within a bound', async () => {
    const largeSchema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, { type: 'string', description: 'x'.repeat(20) }])) }
    const refusingFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith('/capabilities')) {
        const catalog = await (await catalogFetch([])(input, init)).json() as { capabilities: Array<{ id: string; inputSchema: unknown }> }
        return Response.json({ ...catalog, capabilities: catalog.capabilities.map(operation => operation.id === writeId
          ? { ...operation, inputSchema: largeSchema }
          : { ...operation, inputSchema: { type: 'object', required: ['plantId'], properties: { plantId: { type: 'string' } } } }) })
      }
      if (!pathname.endsWith('/invoke')) return catalogFetch([])(input, init)
      const { input: asked } = await request.json() as { input: { refuse: string } }
      return Response.json({ error: { code: asked.refuse, message: 'plantId: Required' } }, { status: 400 })
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: refusingFetch })
    const refusal = async (operationId: string, refuse: string) =>
      ((await call!.execute({ calls: [{ key: 'k', operationId, target: runTarget, input: { refuse } }] }, context)).data as { results: ReadonlyArray<Record<string, unknown>> }).results[0]!

    expect(await refusal(readId, 'invalid_request')).toMatchObject({
      success: false,
      error: 'invalid_request: plantId: Required',
      inputSchema: { type: 'object', required: ['plantId'], properties: { plantId: { type: 'string' } } },
    })
    // A schema over the bound is named for an explicit read, not carried.
    const large = await refusal(writeId, 'invalid_request')
    expect(JSON.stringify(largeSchema).length).toBeGreaterThan(4096)
    expect(large.inputSchema).toBeUndefined()
    expect(large.inputSchemaOmitted).toMatch(new RegExp(`^\\d+ bytes; read it with workspace_explore view=operations, operationIds \\["${writeId.replaceAll('.', '\\.')}"\\], includeInputSchema true$`))
    // A Module's own refusal of a valid-shaped input names its fixes; it carries no schema.
    const rejected = await refusal(readId, 'capability_input_rejected')
    expect(rejected).toMatchObject({ success: false, error: 'capability_input_rejected: plantId: Required' })
    expect(Object.keys(rejected)).not.toContain('inputSchema')
  })

  test('batches independent reads but rejects a batch containing a change', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    expect(await call!.execute({ calls: [
      { key: 'one', operationId: readId, target: runTarget, input: {} },
      { key: 'two', operationId: readId, target: runTarget, input: {} },
    ] }, context)).toMatchObject({ success: true, data: { results: [{ key: 'one', success: true }, { key: 'two', success: true }] } })

    const before = requests.filter(request => request.url.includes('/invoke')).length
    expect(await call!.execute({ calls: [
      { key: 'read', operationId: readId, target: runTarget, input: {} },
      { key: 'write', operationId: writeId, target: runTarget, input: {} },
    ] }, context)).toMatchObject({ success: false, error: expect.stringContaining('batch_requires_read_operations') })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(before)
  })

  test('preflights caller retry keys against discovered operation metadata', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    expect(await call!.execute({ calls: [{
      key: 'read', operationId: readId, target: runTarget, input: {}, idempotencyKey: 'unsupported',
    }] }, context)).toMatchObject({
      success: true,
      data: { results: [{ success: false, error: expect.stringContaining('idempotency_not_supported') }] },
    })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(0)

    expect(await call!.execute({ calls: [{
      key: 'write', operationId: writeId, target: runTarget, input: {}, idempotencyKey: 'supported',
    }] }, context)).toMatchObject({ success: true, data: { results: [{ success: true }] } })
    const invoked = requests.find(request => request.url.includes('/invoke'))!
    expect(await invoked.json()).toMatchObject({ idempotencyKey: 'supported' })
  })

  test('a change that succeeds returns its say line for the person; a refused change returns none', async () => {
    const requests: Request[] = []
    const base = catalogFetch(requests)
    const refusingFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (!new URL(request.url).pathname.endsWith('/invoke')) return base(request)
      const { input: asked } = await request.clone().json() as { input: { refuse?: true } }
      if (asked.refuse) return Response.json({ error: { code: 'simulation_command_rejected', message: 'a person drives this Run' } }, { status: 409 })
      return base(request)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: refusingFetch })
    const line = 'E-0 step 3 · Verified: BUS-A-EMERG 4.16 kV, BUS-B-EMERG 4.16 kV at 10:02:14 → step 4'

    // No execution evidence is needed: a scripted or standalone executor gets the line too.
    const done = await call!.execute({ calls: [{ key: 'step', operationId: writeId, input: {}, say: `  ${line} ` }] }, context)
    expect(done).toMatchObject({ success: true, data: { results: [{ key: 'step', success: true }] }, progress: [{ content: line, operationKey: 'step' }] })
    // The line is for the person: the Module never receives it, and the model's reading of the result does not repeat it.
    const invoked = requests.filter(request => request.url.includes('/invoke'))
    expect(invoked).toHaveLength(1)
    expect(await invoked[0]!.json()).not.toHaveProperty('say')
    expect(JSON.stringify(workspaceCallResultForModel(done, createTurnCards()).data)).not.toContain('BUS-A-EMERG')

    const refused = await call!.execute({ calls: [{ key: 'step', operationId: writeId, input: { refuse: true }, say: line }] }, context)
    expect(refused).toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('simulation_command_rejected') }] } })
    expect(refused).not.toHaveProperty('progress')
    // A line is one short chat line.
    expect(await call!.execute({ calls: [{ key: 'long', operationId: writeId, input: {}, say: 'x'.repeat(301) }] }, context))
      .toMatchObject({ success: false, error: expect.stringContaining('invalid_tool_input') })
    expect(await call!.execute({ calls: [{ key: 'blank', operationId: writeId, input: {}, say: '   ' }] }, context))
      .toMatchObject({ success: false, error: expect.stringContaining('invalid_tool_input') })
  })

  test('a read carrying say is refused before invocation while the other reads of its batch run', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    const result = await call!.execute({ calls: [
      { key: 'said', operationId: readId, target: runTarget, input: {}, say: 'Read the run' },
      { key: 'plain', operationId: readId, target: runTarget, input: {} },
    ] }, context)
    expect(result).toMatchObject({ success: true, data: { results: [
      { key: 'said', success: false, error: expect.stringContaining('say_not_for_reads') },
      { key: 'plain', success: true, data: { state: 'running' } },
    ] } })
    expect(result).not.toHaveProperty('progress')
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(1)
  })

  test('the model learns say from the native schema: a change\'s short line, never a read\'s', () => {
    const [, call] = toolsToDefinitions(makeTools({ kind: 'workspace' }))
    const calls = (call!.function.parameters.properties as Record<string, { items: { properties: Record<string, { description?: string; maxLength?: number }> } }>).calls!
    const say = calls.items.properties.say!
    expect(say.description).toContain('posted to this conversation as your own message once this call succeeds')
    expect(say.description).toContain('Never for reads')
    expect(say.maxLength).toBe(300)
  })

  test('never discovers or invokes the Agents People Capabilities, which serve humans through the Host UI', async () => {
    const agents = moduleIdSchema.parse('agents')
    const peopleSend = capabilityIdSchema.parse('agents.people.message.send')
    const packsList = capabilityIdSchema.parse('agents.packs.list')
    const requests: Request[] = []
    const base = catalogFetch(requests)
    const [explore, call] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!new Request(String(input), init).url.endsWith('/capabilities')) return response
        const body = await response.json() as { modules: unknown[]; capabilities: unknown[] }
        body.modules.push({ moduleId: agents, status: 'ready' })
        body.capabilities.push(
          { id: peopleSend, moduleId: agents, kind: 'command', scope: { kind: 'workspace' }, title: 'Send a direct message', description: 'Sends a text message to another Person.', risk: 'write', idempotent: false, acceptsIdempotencyKey: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
          { id: packsList, moduleId: agents, kind: 'query', scope: { kind: 'workspace' }, title: 'List installed Agent Packs', description: 'Lists Packs.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
        )
        return Response.json(body)
      }) as typeof fetch,
    })
    const browsed = await explore!.execute({ view: 'operations', moduleId: 'agents', limit: 100 }, context)
    expect(browsed).toMatchObject({ success: true, data: { operations: [{ operationId: packsList }] } })
    expect(JSON.stringify(browsed)).not.toContain('agents.people.')
    expect(await explore!.execute({ view: 'operations', operationIds: [peopleSend], queries: ['send direct message person'] }, context))
      .toMatchObject({ success: true, data: { operations: [] } })
    expect(await call!.execute({ calls: [{ key: 'dm', operationId: peopleSend, input: { token: 't', to: 'p', text: 'hi' }, idempotencyKey: 'k' }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('operation_not_advertised') }] } })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(0)
  })

  test('requires a Room with an explicit Scope', async () => {
    const [, call] = makeTools({ kind: 'workspace' })
    expect(await call!.execute({ calls: [{ key: 'state', operationId: readId, target: runTarget, input: {} }] }, {
      callerId: 'agent', callerName: 'Analyst', roomId: 'missing',
    })).toMatchObject({ success: false, error: expect.stringContaining('room_scope_unavailable') })
  })
})

describe('Room Scope follows `about` links one level', () => {
  const planning = moduleIdSchema.parse('planning')
  const planRead = capabilityIdSchema.parse('planning.plan.read')
  const planShow = capabilityIdSchema.parse('planning.plan.display')
  const planCreate = capabilityIdSchema.parse('planning.plan.create')
  const planRef = (id: string) => workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: planning, type: 'planning.plan', id })
  // plan-a is about Run 01, plan-b about Run 02, plan-about-plan-a about plan-a (a second level), plan-unlinked about nothing.
  const planA = planRef('plan-a'), planB = planRef('plan-b'), secondLevel = planRef('plan-about-plan-a'), unlinked = planRef('plan-unlinked')
  const scenario = workspaceDefinitionReferenceSchema.parse({ workspaceId, moduleId, type: definition.type, id: definition.id })
  const planDefinitionRef = (id: string) => workspaceDefinitionReferenceSchema.parse({ workspaceId, moduleId: planning, type: 'planning.plan-definition', id })
  // guided is about the scenario, about-guided about guided (a second level), blank about nothing.
  const guided = planDefinitionRef('guided'), aboutGuided = planDefinitionRef('about-guided'), blank = planDefinitionRef('blank')
  const guidedTarget = { kind: 'definition' as const, ref: { ...guided, revisionId: 'plan-revision-02' } }
  const planResource = (ref: typeof planA, about: ReadonlyArray<typeof run>, capabilityIds: string[] = [planRead]) =>
    ({ ref, title: `Plan ${ref.id}`, capabilityIds, links: about.map(target => ({ rel: 'about', ref: target })), summary: [], observedAt: now })
  const planDefinition = (ref: typeof guided, about: ReadonlyArray<typeof scenario>) =>
    ({ ref, title: `Plan Definition ${ref.id}`, currentRevisionId: 'plan-revision-02', capabilityIds: [planCreate], ...(about.length > 0 ? { links: about.map(target => ({ rel: 'about', ref: target })) } : {}) })

  /** The shared catalogue, where Run 01 came from the scenario, with Planning's Resources and Definitions beside World's. */
  const aboutFetch = (requests: Request[] = []): typeof fetch => {
    const base = catalogFetch(requests)
    return (async (input, init) => {
      const response = await base(input, init)
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (pathname.endsWith('/invoke')) return response
      const body = await response.json() as { modules: unknown[]; resources?: Array<Record<string, unknown>>; definitions?: unknown[]; capabilities?: unknown[] }
      body.modules.push({ moduleId: planning, status: 'ready' })
      if (body.resources) {
        body.resources[0]!.sourceDefinition = definition
        body.resources.push(planResource(planA, [run], [planRead, planShow]), planResource(planB, [otherRun]), planResource(secondLevel, [planA]), planResource(unlinked, []))
      }
      body.definitions?.push(planDefinition(guided, [scenario]), planDefinition(aboutGuided, [guided]), planDefinition(blank, []))
      body.capabilities?.push(
        { id: planRead, moduleId: planning, kind: 'query', scope: { kind: 'resource', resourceType: planA.type }, title: 'Read a plan', description: 'See where a plan stands.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
        { id: planShow, moduleId: planning, kind: 'query', scope: { kind: 'resource', resourceType: planA.type }, title: 'Schedule chart', description: 'Present a schedule option.', risk: 'read', idempotent: true, publishes: ['embedded-view'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
        { id: planCreate, moduleId: planning, kind: 'command', scope: { kind: 'definition', definitionType: guided.type }, title: 'Create a plan', description: 'Start a plan from a template.', risk: 'write', idempotent: false, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      )
      return Response.json(body)
    }) as typeof fetch
  }
  const aboutTools = (scope: WorkspaceRoomScope, requests: Request[] = []) => createWorkspaceCapabilityTools({
    workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined, fetchImpl: aboutFetch(requests),
  })
  const catalogues = async (fetchImpl: typeof fetch) => {
    const read = async (part: string) => await (await fetchImpl(`https://host.test/api/workspaces/${workspaceId}/${part}`)).json()
    return {
      resources: workspaceResourceCatalogSchema.parse(await read('resources')).resources,
      definitions: workspaceDefinitionCatalogSchema.parse(await read('definitions')).definitions,
    }
  }
  const key = comparisonKey
  const listed = (result: { data?: unknown }) => {
    const data = result.data as { resources: Array<{ target: { ref: { id: string } } }>; definitions: Array<{ target: { ref: { id: string; revisionId: string } } }> }
    return { resources: data.resources.map(resource => resource.target.ref.id), definitions: data.definitions.map(entry => `${entry.target.ref.id}@${entry.target.ref.revisionId}`) }
  }
  const runRoom: WorkspaceRoomScope = { kind: 'resource', resource: run }

  test('a Resource about an in-scope Resource is listed with its operations and callable; one about another Resource is not', async () => {
    const requests: Request[] = []
    const [explore, call] = aboutTools(runRoom, requests)
    const scope = await explore!.execute({ view: 'scope' }, { ...context, focusedSubjects: [run, planA, planB] })
    expect(listed(scope).resources).toEqual(['run-01', 'plan-a'])
    // The link reaches the model, so it can tell which Resource a listed one is about.
    expect(scope).toMatchObject({ success: true, data: { focusedSubjects: [run, planA], resources: [{}, { target: { ref: planA }, links: [{ rel: 'about', ref: run }] }] } })
    expect(((await explore!.execute({ view: 'operations' }, context)).data as { operations: Array<{ operationId: string }> }).operations.map(operation => operation.operationId))
      .toEqual([planCreate, planShow, planRead, inspectDefinitionId, readId, writeId])

    expect(await call!.execute({ calls: [{ key: 'inferred', operationId: planRead, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'inferred', success: true }] } })
    expect(await call!.execute({ calls: [{ key: 'named', operationId: planRead, target: { kind: 'resource', ref: planA }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'named', success: true }] } })
    const invoked = requests.filter(request => new URL(request.url).pathname.endsWith('/invoke'))
    expect(await Promise.all(invoked.map(async request => (await request.json() as { resource: unknown }).resource))).toEqual([planA, planA])
    for (const outside of [planB, secondLevel, unlinked]) {
      expect(await call!.execute({ calls: [{ key: 'outside', operationId: planRead, target: { kind: 'resource', ref: outside }, input: {} }] }, context))
        .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })
    }
    expect(requests.filter(request => new URL(request.url).pathname.endsWith('/invoke'))).toHaveLength(2)
  })

  test('the admitted Resource is among the Scope\'s resource keys, which a second level never joins', async () => {
    const { resources, definitions } = await catalogues(aboutFetch())
    const resolved = resolveScope(runRoom, resources, definitions)
    expect([...resolved.resourceKeys]).toEqual([key(run), key(planA)])
    expect(resolved.resources.map(resource => resource.ref)).toEqual([run, planA])
    // A Resource about a Resource the catalogue no longer lists is not admitted: nothing in scope is there for it to belong with.
    const withoutRun = resolveScope(runRoom, resources.filter(resource => resource.ref.id !== run.id), definitions)
    expect([...withoutRun.resourceKeys]).toEqual([key(run)])
    expect(withoutRun.resources).toEqual([])
  })

  test('an excluded or unselected member keeps what is about it out of scope', async () => {
    const everyone = aboutTools({ kind: 'collection', collection: family, members: { mode: 'all', except: [] } })
    expect(listed(await everyone[0]!.execute({ view: 'scope' }, context)).resources).toEqual(['run-01', 'run-02', 'family-01', 'plan-a', 'plan-b'])
    // Two plans are in scope, so a call must say which one it means.
    expect(await everyone[1]!.execute({ calls: [{ key: 'ambiguous', operationId: planRead, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_required') }] } })

    const excluded = aboutTools({ kind: 'collection', collection: family, members: { mode: 'all', except: [otherRun] } })
    expect(listed(await excluded[0]!.execute({ view: 'scope' }, context)).resources).toEqual(['run-01', 'family-01', 'plan-a'])
    expect(await excluded[1]!.execute({ calls: [{ key: 'excluded', operationId: planRead, target: { kind: 'resource', ref: planB }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })

    const selected = aboutTools({ kind: 'collection', collection: family, members: { mode: 'selected', only: [otherRun] } })
    expect(listed(await selected[0]!.execute({ view: 'scope' }, context)).resources).toEqual(['run-02', 'family-01', 'plan-b'])
    expect(await selected[1]!.execute({ calls: [{ key: 'unselected', operationId: planRead, target: { kind: 'resource', ref: planA }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })
  })

  test('a Definition about an in-scope Definition is listed at its current revision with its operations; one without the link, or a second level, is not', async () => {
    const requests: Request[] = []
    const [explore, call] = aboutTools(runRoom, requests)
    const scope = await explore!.execute({ view: 'scope' }, context)
    // The Run pins its source revision; the Definition about that source is the library's current one.
    expect(listed(scope).definitions).toEqual(['scenario-01@revision-01', 'guided@plan-revision-02'])
    expect(scope).toMatchObject({ success: true, data: { definitions: [{}, { target: guidedTarget, links: [{ rel: 'about', ref: scenario }] }] } })
    expect(await explore!.execute({ view: 'operations', target: guidedTarget }, context))
      .toMatchObject({ success: true, data: { operations: [{ operationId: planCreate }] } })

    expect(await call!.execute({ calls: [{ key: 'inferred', operationId: planCreate, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'inferred', success: true }] } })
    const [invoked] = requests.filter(request => new URL(request.url).pathname.endsWith('/invoke'))
    expect((await invoked!.json() as { definition: unknown }).definition).toEqual(guidedTarget.ref)
    for (const outside of [blank, aboutGuided]) {
      const target = { kind: 'definition' as const, ref: { ...outside, revisionId: 'plan-revision-02' } }
      expect(await call!.execute({ calls: [{ key: 'outside', operationId: planCreate, target, input: {} }] }, context))
        .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })
      expect(await explore!.execute({ view: 'operations', target }, context)).toMatchObject({ success: false, error: expect.stringContaining('target_out_of_scope') })
    }
    expect(await call!.execute({ calls: [{ key: 'old', operationId: planCreate, target: { kind: 'definition', ref: { ...guided, revisionId: 'plan-revision-01' } }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })

    // Run 02 names no source Definition, so nothing is about a Definition in its Scope.
    const [exploreOther, callOther] = aboutTools({ kind: 'resource', resource: otherRun })
    expect(listed(await exploreOther!.execute({ view: 'scope' }, context))).toEqual({ resources: ['run-02', 'plan-b'], definitions: [] })
    expect(await callOther!.execute({ calls: [{ key: 'none', operationId: planCreate, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_required') }] } })
  })

  test('the admitted Resource\'s display publisher is reachable in the Room, and no other Room\'s', async () => {
    const lookup = (scope: WorkspaceRoomScope) => createViewPublisherLookup({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined, fetchImpl: aboutFetch(),
    })
    expect(await lookup(runRoom)('room')).toEqual([planShow])
    expect(await lookup({ kind: 'resource', resource: otherRun })('room')).toEqual([])
  })

  test('a Room scoped to the whole Workspace is unchanged: every listed Resource and Definition, as listed', async () => {
    const { resources, definitions } = await catalogues(aboutFetch())
    const resolved = resolveScope({ kind: 'workspace' }, resources, definitions)
    expect(resolved.resources).toBe(resources)
    expect(resolved.definitions).toBe(definitions)
    expect([...resolved.resourceKeys]).toEqual(resources.map(resource => key(resource.ref)))
    expect([...resolved.definitionKeys]).toEqual(definitions.map(entry => key(entry.ref)))
    const [explore] = aboutTools({ kind: 'workspace' })
    expect(listed(await explore!.execute({ view: 'scope' }, context))).toEqual({
      resources: ['run-01', 'run-02', 'family-01', 'plan-a', 'plan-b', 'plan-about-plan-a', 'plan-unlinked'],
      definitions: ['scenario-01@revision-01', 'guided@plan-revision-02', 'about-guided@plan-revision-02', 'blank@plan-revision-02'],
    })
  })

  test('a Room whose catalogue holds no `about` link resolves exactly as the Scope names it', async () => {
    const plain = (async (input, init) => {
      const response = await catalogFetch([])(input, init)
      if (!new URL(String(input)).pathname.endsWith('/resources')) return response
      const body = await response.json() as { resources: Array<Record<string, unknown>> }
      body.resources[0]!.sourceDefinition = definition
      body.resources[1]!.sourceDefinition = definition
      return Response.json(body)
    }) as typeof fetch
    const { resources, definitions } = await catalogues(plain)
    const [run01, run02, runFamily] = resources
    const pinned = { ...definitions[0]!, currentRevisionId: definition.revisionId }
    const shape = (scope: WorkspaceRoomScope) => {
      const resolved = resolveScope(scope, resources, definitions)
      return JSON.stringify({ ...resolved, resourceKeys: [...resolved.resourceKeys], definitionKeys: [...resolved.definitionKeys] })
    }
    const expected = (scope: WorkspaceRoomScope, scoped: unknown[], resourceKeys: string[]) =>
      JSON.stringify({ scope, resources: scoped, definitions: [pinned], resourceKeys, definitionKeys: [key(definition)] })
    const single: WorkspaceRoomScope = { kind: 'resource', resource: run }
    expect(shape(single)).toBe(expected(single, [run01], [key(run)]))
    const all: WorkspaceRoomScope = { kind: 'collection', collection: family, members: { mode: 'all', except: [] } }
    expect(shape(all)).toBe(expected(all, [run01, run02, runFamily], [key(family), key(run), key(otherRun)]))
    const except: WorkspaceRoomScope = { kind: 'collection', collection: family, members: { mode: 'all', except: [run] } }
    expect(shape(except)).toBe(expected(except, [run02, runFamily], [key(family), key(otherRun)]))
    const only: WorkspaceRoomScope = { kind: 'collection', collection: family, members: { mode: 'selected', only: [run] } }
    expect(shape(only)).toBe(expected(only, [run01, runFamily], [key(family), key(run)]))
  })

  describe('and bounds the Resources a call names in its input, where the operation declares them', () => {
    const planEdit = capabilityIdSchema.parse('planning.plan.edit')
    const planCompare = capabilityIdSchema.parse('planning.plan.compare')
    // Run 03 belongs to another family.
    const strangerRun = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-03' })
    const otherFamily = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.run-family', id: 'family-02' })
    const runAt = (path: string) => ({ path, moduleId, type: run.type })
    const createDeclares = [runAt('demoRun'), runAt('edits[].run')]
    const compareDeclares = [{ path: 'with', moduleId: planning, type: planA.type }, runAt('runs[]'), runAt('rows[].cells[].run')]

    /** The `about` catalogue with a second family, and operations that declare where their input names a Resource. */
    const declaredFetch = (requests: Request[] = []): typeof fetch => {
      const base = aboutFetch(requests)
      return (async (input, init) => {
        const response = await base(input, init)
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
        if (pathname.endsWith('/invoke')) return response
        const body = await response.json() as { resources?: Array<{ ref: { type: string }; capabilityIds: string[] }>; capabilities?: Array<Record<string, unknown>> }
        if (body.resources) {
          for (const resource of body.resources) if (resource.ref.type === planA.type) resource.capabilityIds.push(planEdit, planCompare)
          body.resources.push(
            { ref: strangerRun, title: 'Run 03', capabilityIds: [readId], links: [{ rel: 'member-of', ref: otherFamily }], summary: [], observedAt: now } as never,
            { ref: otherFamily, title: 'Other family', capabilityIds: [], links: [{ rel: 'contains', ref: strangerRun }], summary: [], observedAt: now } as never,
          )
        }
        if (body.capabilities) {
          body.capabilities.find(capability => capability.id === planCreate)!.resourceInputs = createDeclares
          body.capabilities.push(
            { id: planEdit, moduleId: planning, kind: 'command', scope: { kind: 'resource', resourceType: planA.type }, title: 'Change a plan', description: 'Change a plan with named edits.', risk: 'write', idempotent: false, resourceInputs: [runAt('edits[].run')], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
            { id: planCompare, moduleId: planning, kind: 'query', scope: { kind: 'resource', resourceType: planA.type }, title: 'Compare plans', description: 'Compare a plan with another.', risk: 'read', idempotent: true, resourceInputs: compareDeclares, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
          )
        }
        return Response.json(body)
      }) as typeof fetch
    }
    const declaredTools = (scope: WorkspaceRoomScope, requests: Request[] = []) => createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined, fetchImpl: declaredFetch(requests),
    })
    const invocations = (requests: Request[]) => requests.filter(request => new URL(request.url).pathname.endsWith('/invoke'))
    const familyRoom = (members: Extract<WorkspaceRoomScope, { kind: 'collection' }>['members']): WorkspaceRoomScope => ({ kind: 'collection', collection: family, members })
    /** One call's result, and how many invocations reached the Host for it. */
    const attempt = async (scope: WorkspaceRoomScope, operationId: string, input: unknown, target?: unknown) => {
      const requests: Request[] = []
      const result = await declaredTools(scope, requests)[1]!.execute({ calls: [{ key: 'c', operationId, input, ...(target === undefined ? {} : { target }) }] }, context)
      const [entry] = (result.data as { results: Array<{ success: boolean; error?: string; details?: unknown }> }).results
      return { result, entry: entry!, sent: invocations(requests) }
    }
    const refusal = (at: string, resource: unknown, scope: WorkspaceRoomScope) => ({
      key: 'c', success: false,
      error: `input_out_of_scope: Input ${at} names a Resource outside the current Room Scope`,
      details: { code: 'input_out_of_scope', details: { input: at, resource, scope } },
    })
    const planATarget = { kind: 'resource' as const, ref: planA }

    test('an id of a Resource in scope passes as given; one outside is refused by name before anything is sent', async () => {
      const inside = await attempt(runRoom, planCreate, { demoRun: run.id })
      expect(inside.entry).toMatchObject({ success: true, target: guidedTarget })
      expect(inside.sent).toHaveLength(1)
      expect(await inside.sent[0]!.json()).toMatchObject({ definition: guidedTarget.ref, input: { demoRun: run.id } })

      const outside = await attempt(runRoom, planCreate, { demoRun: otherRun.id })
      expect(outside.entry).toEqual({ ...refusal('demoRun', otherRun, runRoom), operationId: planCreate } as never)
      expect(outside.sent).toHaveLength(0)
      expect(outside.result).toMatchObject({ success: true, effects: [{ kind: 'change', outcome: 'not-dispatched', operationId: planCreate, target: guidedTarget }] })
      // An id no Resource has, or one that could be no Resource's id, is outside every Scope.
      for (const id of ['run-99', ' run-01', 'RUN-01', '']) expect((await attempt(runRoom, planCreate, { demoRun: id })).entry.error).toContain('input_out_of_scope: Input demoRun ')
    })

    test('a Run of another family, an excluded member and an unselected member are refused; the family is not its Run', async () => {
      const everyone = familyRoom({ mode: 'all', except: [] })
      for (const member of [run, otherRun]) expect((await attempt(everyone, planCreate, { demoRun: member.id }, guidedTarget)).sent).toHaveLength(1)
      const stranger = await attempt(everyone, planCreate, { demoRun: strangerRun.id }, guidedTarget)
      expect(stranger.entry).toEqual({ ...refusal('demoRun', strangerRun, everyone), operationId: planCreate } as never)
      expect(stranger.sent).toHaveLength(0)
      // The family is in scope as a family: its id names no Run.
      const asRun = await attempt(everyone, planCreate, { demoRun: family.id }, guidedTarget)
      expect(asRun.entry.error).toContain('input_out_of_scope')
      expect(asRun.sent).toHaveLength(0)

      const excluded = await attempt(familyRoom({ mode: 'all', except: [otherRun] }), planCreate, { demoRun: otherRun.id }, guidedTarget)
      expect(excluded.entry.error).toBe('input_out_of_scope: Input demoRun names a Resource outside the current Room Scope')
      expect(excluded.sent).toHaveLength(0)
      expect((await attempt(familyRoom({ mode: 'all', except: [otherRun] }), planCreate, { demoRun: run.id }, guidedTarget)).sent).toHaveLength(1)

      const unselected = await attempt(familyRoom({ mode: 'selected', only: [run] }), planCreate, { demoRun: otherRun.id }, guidedTarget)
      expect(unselected.entry.error).toBe('input_out_of_scope: Input demoRun names a Resource outside the current Room Scope')
      expect(unselected.sent).toHaveLength(0)
      expect((await attempt(familyRoom({ mode: 'selected', only: [run] }), planCreate, { demoRun: run.id }, guidedTarget)).sent).toHaveLength(1)
    })

    test('a declared path reaches into arrays: every id found there is judged, and the refusal names the place', async () => {
      const linked = await attempt(runRoom, planEdit, { edits: [{ edit: 'job', key: 'restore' }, { edit: 'plan', run: run.id }] }, planATarget)
      expect(linked.entry.success).toBe(true)
      expect(await linked.sent[0]!.json()).toMatchObject({ resource: planA, input: { edits: [{ edit: 'job', key: 'restore' }, { edit: 'plan', run: run.id }] } })

      const relinked = await attempt(runRoom, planEdit, { edits: [{ edit: 'plan', run: run.id }, { edit: 'job', key: 'restore' }, { edit: 'plan', run: otherRun.id }] }, planATarget)
      expect(relinked.entry).toEqual({ ...refusal('edits[2].run', otherRun, runRoom), operationId: planEdit } as never)
      expect(relinked.sent).toHaveLength(0)
      // The same path on another operation of the same input shape.
      expect((await attempt(runRoom, planCreate, { edits: [{ edit: 'plan', run: strangerRun.id }] })).entry.error)
        .toBe('input_out_of_scope: Input edits[0].run names a Resource outside the current Room Scope')

      const nested = await attempt(runRoom, planCompare, { rows: [{ cells: [{ run: run.id }] }, { cells: [{ run: run.id }, { run: otherRun.id }] }] }, planATarget)
      expect(nested.entry).toEqual({ ...refusal('rows[1].cells[1].run', otherRun, runRoom), operationId: planCompare } as never)
      const listed = await attempt(runRoom, planCompare, { runs: [run.id, otherRun.id] }, planATarget)
      expect(listed.entry).toEqual({ ...refusal('runs[1]', otherRun, runRoom), operationId: planCompare } as never)
      expect((await attempt(runRoom, planCompare, { runs: [run.id, run.id], rows: [{ cells: [{ run: run.id }] }] }, planATarget)).sent).toHaveLength(1)
    })

    test('null, a missing place and a value of another shape are the Module\'s to validate', async () => {
      const left = [
        { edits: [{ edit: 'plan', run: null }] }, { edits: [{ edit: 'plan', title: 'Week 47' }] }, { edits: [{ edit: 'plan', run: 42 }] },
        { edits: [{ edit: 'plan', run: { id: otherRun.id } }] }, { edits: [{ edit: 'plan', run: [otherRun.id] }] },
        { edits: { run: otherRun.id } }, { edits: 'run-02' }, { edits: [otherRun.id, null, 7] }, { edits: [] }, {}, null, undefined, 'run-02', [{ run: otherRun.id }],
      ]
      for (const input of left) {
        const tried = await attempt(runRoom, planEdit, input, planATarget)
        expect([JSON.stringify(input), tried.entry.success, tried.sent.length]).toEqual([JSON.stringify(input), true, 1])
      }
      // An object shaped like an array is not one.
      expect((await attempt(runRoom, planCompare, { runs: { length: 1, 0: otherRun.id } }, planATarget)).sent).toHaveLength(1)
    })

    test('a Resource in scope only through the `about` rule may be named; one about another Resource, or a second level, may not', async () => {
      const admitted = await attempt(runRoom, planCompare, { with: planA.id }, planATarget)
      expect(admitted.entry.success).toBe(true)
      expect(admitted.sent).toHaveLength(1)
      for (const outside of [planB, secondLevel, unlinked]) {
        const tried = await attempt(runRoom, planCompare, { with: outside.id }, planATarget)
        expect(tried.entry).toEqual({ ...refusal('with', outside, runRoom), operationId: planCompare } as never)
        expect(tried.sent).toHaveLength(0)
      }
      // The declared Module and type decide what an id names: a Run's id is no plan.
      expect((await attempt(runRoom, planCompare, { with: run.id }, planATarget)).entry.error).toContain('input_out_of_scope: Input with ')

      // A refused read leaves the other reads of its batch running.
      const requests: Request[] = []
      const batch = await declaredTools(runRoom, requests)[1]!.execute({ calls: [
        { key: 'inside', operationId: planCompare, target: planATarget, input: { with: planA.id } },
        { key: 'outside', operationId: planCompare, target: planATarget, input: { with: planB.id } },
      ] }, context)
      expect(batch).toMatchObject({ success: true, data: { results: [{ key: 'inside', success: true }, { key: 'outside', success: false, error: expect.stringContaining('input_out_of_scope') }] },
        effects: [{ outcome: 'returned' }, { outcome: 'not-dispatched' }] })
      expect(invocations(requests)).toHaveLength(1)
    })

    test('a Room scoped to the whole Workspace passes anything', async () => {
      const workspace: WorkspaceRoomScope = { kind: 'workspace' }
      for (const [operationId, input, target] of [
        [planCreate, { demoRun: strangerRun.id }, guidedTarget], [planCreate, { demoRun: 'run-99' }, guidedTarget],
        [planEdit, { edits: [{ edit: 'plan', run: otherRun.id }] }, planATarget], [planCompare, { with: unlinked.id, runs: ['run-99'] }, planATarget],
      ] as const) {
        const tried = await attempt(workspace, operationId, input, target)
        expect([operationId, tried.entry.success, tried.sent.length]).toEqual([operationId, true, 1])
        expect(await tried.sent[0]!.json()).toMatchObject({ input })
      }
    })

    test('an operation that declares nothing is unaffected, whatever its input holds', async () => {
      const input = { demoRun: otherRun.id, with: planB.id, runs: [strangerRun.id], edits: [{ edit: 'plan', run: otherRun.id }] }
      for (const [operationId, target] of [[planRead, planATarget], [readId, runTarget], [writeId, runTarget]] as const) {
        const tried = await attempt(runRoom, operationId, input, target)
        expect([operationId, tried.entry.success, tried.sent.length]).toEqual([operationId, true, 1])
        expect(await tried.sent[0]!.json()).toMatchObject({ input })
      }
    })

    test('discovery shows a declaration with its operation, and an operation without one exactly as before', async () => {
      type Listed = { operations: Array<{ operationId: string } & Record<string, unknown>> }
      const operations = async (tools: ReturnType<typeof aboutTools>) => new Map(((await tools[0]!.execute(
        { view: 'operations', includeInputSchema: true, includeOutputSchema: true, limit: 50 }, context)).data as Listed).operations.map(operation => [operation.operationId, operation]))
      const before = await operations(aboutTools({ kind: 'workspace' }))
      const after = await operations(declaredTools({ kind: 'workspace' }))
      expect([...after.keys()].sort()).toEqual([...before.keys(), planEdit, planCompare].sort())
      for (const [operationId, operation] of before) {
        if (operationId === planCreate) continue
        expect(JSON.stringify(after.get(operationId))).toBe(JSON.stringify(operation))
        expect(operation).not.toHaveProperty('resourceInputs')
      }
      const { resourceInputs, ...rest } = after.get(planCreate)!
      expect(resourceInputs).toEqual(createDeclares)
      expect(JSON.stringify(rest)).toBe(JSON.stringify(before.get(planCreate)))
      expect(after.get(planCompare)!.resourceInputs).toEqual(compareDeclares)
    })
  })
})
