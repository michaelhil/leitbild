import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wikiManifestSchema, workspaceIdSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createReferenceEligibilityFetch, PILOT_ARMS, PILOT_TOOLS, pilotOrder, reviewedWikiPages, runKnowledgePilot } from './knowledge-pilot.ts'
import { createAgentsWorkspaceRuntime } from '../src/workspace-runtime.ts'
import { createDeploymentRuntime } from '../src/core/deployment-runtime.ts'
import { buildToolSupport } from '../src/agents/spawn.ts'
import { PWR_OPS_MANIFEST } from '../src/packs/pwr-ops/manifest.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const source = PWR_OPS_MANIFEST.wikis[0]!.source!
const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const workspaceUrl = `https://pilot.test/api/workspaces/${workspaceId}`
const resource = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'test-run' })
const revision = 'a'.repeat(40)
const manifest = wikiManifestSchema.parse({ version: 1, wiki: 'pwr-ops', revision, procmdVersion: '0.7',
  procedures: [{ id: 'E-0', title: 'Procedure canary', file: 'wiki/procedures/E-0.md', coverage: 'developed', stepCount: 1, tagDefinitionCount: 0 }],
  pages: [
    { id: 'cooling', type: 'system-description', title: 'Cooling', file: 'wiki/systems/cooling.md' },
    { id: 'E-0', type: 'handbook', title: 'Disguised procedure', file: 'wiki/procedures/E-0.md' },
    { id: 'other-procedure', type: 'procedure', title: 'Procedure class', file: 'wiki/other.md' },
    { id: 'answer-key', type: 'scenario', title: 'Evaluator material', file: 'wiki/scenarios/answer-key.md' },
  ],
})
const pages = new Map([['wiki/systems/cooling.md', '# Cooling\nWIKI_CANARY_83A. Shared procedure facts are not erased.']])
const raw = (file: string, sha = revision) => `https://raw.githubusercontent.com/${source.org}/${source.repo}/${sha}/${file}`

test('two seeded blocks contain each arm exactly once', () => {
  expect(pilotOrder(42)).toEqual(pilotOrder(42))
  const order = pilotOrder(42)
  expect(order).toHaveLength(8)
  expect([...order.slice(0, 4)].sort()).toEqual([...PILOT_ARMS].sort())
  expect([...order.slice(4)].sort()).toEqual([...PILOT_ARMS].sort())
})

test('reviewed positive subset rejects procedure files regardless of misleading page type', () => {
  expect(reviewedWikiPages(manifest, ['wiki/systems/cooling.md'])).toHaveLength(1)
  for (const file of ['wiki/procedures/E-0.md', 'wiki/other.md', 'missing.md']) expect(() => reviewedWikiPages(manifest, [file])).toThrow()
  expect(() => reviewedWikiPages(manifest, ['wiki/systems/cooling.md', 'wiki/systems/cooling.md'])).toThrow('Duplicate')
})

test('all arms gate complete procedure/document routes and exact pinned wiki reads without changing live reads', async () => {
  for (const arm of PILOT_ARMS) {
    const requests: string[] = []
    const fetchImpl = createReferenceEligibilityFetch({ arm, source, manifest, pages, workspaceUrl,
      fetchImpl: (async (input: string | URL | Request) => {
        requests.push(String(input instanceof Request ? input.url : input))
        const url = String(input instanceof Request ? input.url : input)
        return Response.json({ result: url.includes('world.procedure.') ? { source: { revision }, canary: 'PROCEDURE_CANARY_5E2' } : { rawValue: 15.5, unit: 'MPa' } })
      }) as typeof fetch,
    })
    const index = await (await fetchImpl(source.manifestUrl)).json() as { pages: unknown[]; procedures: unknown[] }
    expect(index.procedures).toEqual([])
    expect(index.pages).toHaveLength(arm === 'wiki' || arm === 'both' ? 1 : 0)
    const document = await fetchImpl(raw('wiki/systems/cooling.md'))
    expect((await document.text()).includes('WIKI_CANARY_83A')).toBe(arm === 'wiki' || arm === 'both')
    for (const file of ['wiki/procedures/E-0.md', 'wiki/other.md', 'wiki/scenarios/answer-key.md']) expect((await fetchImpl(raw(file))).status).toBe(403)
    expect((await fetchImpl(raw('wiki/systems/cooling.md', 'b'.repeat(40)))).status).toBe(403)
    for (const operation of ['world.procedure.catalog.list', 'world.procedure.document.read']) {
      expect((await fetchImpl(`${workspaceUrl}/capabilities/${operation}/invoke`, { method: 'POST', body: JSON.stringify({ input: { includeSource: true, stepId: 'step-one' } }) })).status)
        .toBe(arm === 'procedures' || arm === 'both' ? 200 : 403)
    }
    const live = await fetchImpl(`${workspaceUrl}/capabilities/world.process-plant.signals.read/invoke`, { method: 'POST', body: '{}' })
    expect(await live.json()).toEqual({ result: { rawValue: 15.5, unit: 'MPa' } })
    expect(requests).not.toContain(raw('wiki/procedures/E-0.md'))
  }
})

test('real four-tool Workspace executor has no alternate document routes in any arm', async () => {
  for (const arm of PILOT_ARMS) {
  const ids = ['world.procedure.catalog.list', 'world.procedure.document.read', 'world.procedure.runs.list', 'world.process-plant.signals.read', 'world.simulation-run.scenario-source']
  globalThis.fetch = createReferenceEligibilityFetch({ arm, source, manifest, pages, workspaceUrl,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      const base = { workspaceId, modules: [{ moduleId: 'world', status: 'ready' }] }
      if (url.endsWith('/capabilities')) return Response.json({ ...base, capabilities: ids.map(id => ({
        id, moduleId: 'world', kind: 'query', scope: { kind: 'resource', resourceType: resource.type }, title: id,
        description: id, risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      })) })
      if (url.endsWith('/definitions')) return Response.json({ ...base, definitions: [] })
      if (url.endsWith('/resources')) return Response.json({ ...base, resources: [{ ref: resource, title: 'Frozen test Run', capabilityIds: ids, links: [], summary: [], observedAt: '2026-09-06T00:00:00Z' }] })
      if (url.includes('/world.procedure.runs.list/')) return Response.json({ result: { runs: [] } })
      if (url.includes('/world.procedure.')) return Response.json({ result: { source: { revision }, content: 'PROCEDURE_CANARY_5E2' } })
      if (url.includes('/world.process-plant.signals.read/')) return Response.json({ result: { value: 15.5, unit: 'MPa' } })
      if (url.includes('/world.simulation-run.scenario-source/')) return Response.json({ result: { source: { reviewed: true } } })
      throw new Error('Unexpected external request in deterministic canary')
    }) as typeof fetch,
  })
  const deployment = createDeploymentRuntime()
  const runtime = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: 'https://pilot.test' })
  try {
    // Test-only forbidden readers return a canary if selection ever leaks.
    const forbidden = ['product_read', 'product_search', 'web_fetch', 'pwr-ops_procedure_lookup', 'pwr-ops_wiki_search', 'pwr-ops_eal_assess']
    for (const name of forbidden) runtime.toolRegistry.register({ name, description: '', parameters: {}, execute: async () => ({ success: true, data: 'FORBIDDEN_CANARY_9BF' }) })
    const room = runtime.rooms.createRoom({ name: 'Canary', createdBy: 'test', scope: { kind: 'resource', resource } })
    room.setActivePacks(['pwr-ops'])
    const support = await buildToolSupport(PILOT_TOOLS, runtime.toolRegistry, { id: 'reader', name: 'Reader' }, runtime.llm, id => runtime.rooms.getRoom(id))
    expect(support.resolveToolDefinitions!(room.profile.id)!.map(tool => tool.function.name).sort()).toEqual([...PILOT_TOOLS].sort())
    for (const tool of runtime.toolRegistry.list().filter(tool => !PILOT_TOOLS.some(name => name === tool.name))) {
      const result = await support.toolExecutor!([{ tool: tool.name, arguments: {} }], room.profile.id)
      expect(result[0]?.success).toBe(false)
      expect(JSON.stringify(result)).not.toContain('FORBIDDEN_CANARY_9BF')
    }
    const invoke = async (args: Record<string, unknown>) => (await support.toolExecutor!([{ tool: 'wiki_lookup', arguments: args }], room.profile.id))[0]!
    const selected = { packId: 'pwr-ops', wikiUrl: PWR_OPS_MANIFEST.wikis[0]!.url }
    const index = await invoke(selected)
    expect(JSON.stringify(index)).not.toContain('Disguised procedure')
    expect(JSON.stringify(index)).not.toContain('Evaluator material')
    expect(await invoke({ ...selected, type: 'handbook', id: 'E-0' })).toMatchObject({ success: false })
    expect(await invoke({ ...selected, wikiUrl: 'https://unlisted.test/', type: 'system-description', id: 'cooling' })).toMatchObject({ success: false })
    const wiki = await invoke({ ...selected, type: 'system-description', id: 'cooling' })
    expect(JSON.stringify(wiki).includes('WIKI_CANARY_83A')).toBe(arm === 'wiki' || arm === 'both')
    for (const operationId of ids) {
      const result = (await support.toolExecutor!([{ tool: 'workspace_call', arguments: { calls: [{ key: 'read', operationId, input: {} }] } }], room.profile.id))[0]!
      expect(result.success).toBe(true)
      const rows = (result.data as { results: Array<{ success: boolean; data?: unknown }> }).results
      if (operationId === 'world.procedure.document.read' || operationId === 'world.procedure.catalog.list') {
        expect(rows[0]?.success).toBe(arm === 'procedures' || arm === 'both')
        expect(JSON.stringify(rows).includes('PROCEDURE_CANARY_5E2')).toBe(arm === 'procedures' || arm === 'both')
      } else {
        expect(rows[0]?.success).toBe(true)
        expect(JSON.stringify(rows)).not.toContain('PROCEDURE_CANARY_5E2')
        expect(JSON.stringify(rows)).not.toContain('WIKI_CANARY_83A')
      }
    }
  } finally { runtime.triggerScheduler.stop(); runtime.summaryScheduler.dispose(); await runtime.resetState(); runtime.executionStore.close(); deployment.providerSetup.dispose() }
  }
})

test('changed World source revision cannot supply unreviewed procedure content', async () => {
  const fetchImpl = createReferenceEligibilityFetch({ arm: 'both', source, manifest, pages, workspaceUrl,
    fetchImpl: (async () => Response.json({ result: { source: { revision: 'b'.repeat(40) }, content: 'UNREVIEWED_CANARY' } })) as unknown as typeof fetch,
  })
  const response = await fetchImpl(`${workspaceUrl}/capabilities/world.procedure.document.read/invoke`, { method: 'POST', body: '{}' })
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain('UNREVIEWED_CANARY')
})

test('manual runner uses the real runtime/provider stack and saves eight complete fresh conversations without network or paid calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-knowledge-pilot-'))
  const env = { LEITBILD_HOME: process.env.LEITBILD_HOME, PROVIDER_ORDER: process.env.PROVIDER_ORDER, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, PROVIDER: process.env.PROVIDER }
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  let generations = 0
  try {
    process.env.LEITBILD_HOME = directory
    process.env.PROVIDER_ORDER = 'openrouter'
    process.env.OPENROUTER_API_KEY = 'test-only-not-a-real-key'
    delete process.env.PROVIDER
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const url = request.url
      if (url === source.manifestUrl) return Response.json(manifest)
      if (url === raw('wiki/systems/cooling.md')) return new Response(pages.get('wiki/systems/cooling.md'))
      if (url.endsWith('/world.simulation-run.context/invoke')) return Response.json({ result: { situation: {
        sequence: 1, clock: { simulationTime: '2026-09-06T00:00:00Z' }, procedures: { runs: [] },
        execution: { state: { playback: 'paused', currentSimulationTime: '2026-09-06T00:00:00Z' } },
      } } })
      if (url.endsWith('/world.simulation-run.scenario-source/invoke')) return Response.json({ result: { source: { title: 'Neutral test source', objects: [] } } })
      if (url.endsWith('/world.procedure.catalog.list/invoke')) return Response.json({ result: { source: { repository: `${source.org}/${source.repo}`, revision, fetchedAt: new Date().toISOString() }, procedures: [] } })
      if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [{ id: 'test/model', context_length: 100_000, supported_parameters: ['tools', 'temperature', 'seed'] }] })
      if (url === 'https://openrouter.ai/api/v1/chat/completions') {
        generations++
        const body = await request.json() as { model: string; stream: boolean; messages: Array<{ role: string }> }
        expect(body.model).toBe('test/model')
        expect(body.stream).toBe(true)
        const answering = body.messages.at(-1)?.role === 'tool'
        const chunks = [
          { model: 'test/model', choices: [{ index: 0, delta: answering ? { content: 'Observed fixture evidence; no changes made.' } : {
            tool_calls: [{ index: 0, id: 'Call12345', type: 'function', function: { name: 'wiki_lookup', arguments: '{}' } }],
          }, finish_reason: null }] },
          { model: 'test/model', choices: [{ index: 0, delta: {}, finish_reason: answering ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 8 } },
        ]
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected deterministic transport URL: ${url}`)
    }) as typeof fetch
    const config = { hostOrigin: 'https://pilot.test', resource, model: 'openrouter:test/model', temperature: 0, seed: 42,
      timeoutMs: 2000, maxToolIterations: 8, questions: ['Read live state. Do not change anything.', 'Explain the indication.', 'What evidence is missing?', 'Summarize uncertainty.'],
      wikiFiles: ['wiki/systems/cooling.md'], reviewNote: 'Test-only neutral source and canary fixture reviewed.', outputDirectory: join(directory, 'results'),
    }
    await runKnowledgePilot(config)
    expect(generations).toBe(0)
    const prepared = JSON.parse(await readFile(join(config.outputDirectory, 'preparation.json'), 'utf8')) as { preparationHash: string }
    await expect(runKnowledgePilot({ ...config, approvedPreparationHash: 'wrong' }, true)).rejects.toThrow('Preparation changed')
    expect(generations).toBe(0)
    await runKnowledgePilot({ ...config, approvedPreparationHash: prepared.preparationHash }, true)
    expect(generations).toBe(64)
    const roomIds = new Set<string>()
    for (const [index, arm] of pilotOrder(42).entries()) {
      const text = await readFile(join(config.outputDirectory, `conversation-${index + 1}-${arm}.json`), 'utf8')
      const result = JSON.parse(text) as { failure?: string; turns: Array<{ roomId: string; status: string; calls: Array<{ result?: { success: boolean } }> }>; queries: unknown[]; transport: Array<{ wireRequest?: unknown }> }
      expect(result.failure).toBeUndefined()
      expect(result.turns).toHaveLength(4)
      expect(result.turns.every(turn => turn.status === 'completed')).toBe(true)
      expect(result.turns.every(turn => turn.calls.length === 1 && turn.calls[0]?.result?.success === true)).toBe(true)
      roomIds.add(result.turns[0]!.roomId)
      expect(result.queries).toHaveLength(4)
      expect(result.transport.filter(entry => entry.wireRequest)).toHaveLength(8)
      expect(text).not.toContain('test-only-not-a-real-key')
      expect(text).not.toContain('Authorization')
    }
    expect(roomIds.size).toBe(8)
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    log.mockRestore(); warn.mockRestore(); globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})
