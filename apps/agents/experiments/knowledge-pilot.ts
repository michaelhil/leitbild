// Manual, test-only restricted-profile document-eligibility pilot. Never imported
// by production. Prepare/review first; --run explicitly enables paid generation.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { workspaceResourceReferenceSchema, type WikiManifest } from '@leitbild/contracts'
import { buildProviderStack } from '../src/boot/provider-stack.ts'
import { createAgentsWorkspaceRuntime, type AgentsWorkspaceRuntime } from '../src/workspace-runtime.ts'
import { buildToolSupport } from '../src/agents/spawn.ts'
import { asAIAgent } from '../src/agents/shared.ts'
import { getBundledRoomDefinition } from '../src/core/definitions/room-definition-catalog.ts'
import { REASONING_EFFORTS } from '../src/core/types/llm.ts'
import { createLLMRequestError } from '../src/llm/errors.ts'
import { loadSkills } from '../src/skills/loader.ts'
import { PWR_OPS_MANIFEST } from '../src/packs/pwr-ops/manifest.ts'
import { createWikiSource } from '../src/wikis/wiki-fetcher.ts'
import type { WikiSourceBinding } from '../src/packs/types.ts'

export const PILOT_TOOLS = ['workspace_explore', 'workspace_call', 'wiki_lookup', 'conversation_read'] as const
export const PILOT_ARMS = ['none', 'wiki', 'procedures', 'both'] as const
export type PilotArm = typeof PILOT_ARMS[number]
const configSchema = z.object({
  hostOrigin: z.url(), resource: workspaceResourceReferenceSchema,
  model: z.string().regex(/^openrouter:[^:]+\/[^:]+$/), temperature: z.number().finite(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(), seed: z.number().int(),
  timeoutMs: z.number().int().positive(), maxToolIterations: z.number().int().positive(),
  questions: z.array(z.string().min(1)).length(4), wikiFiles: z.array(z.string().min(1)).min(1),
  reviewNote: z.string().min(1), outputDirectory: z.string().min(1),
  approvedPreparationHash: z.string().optional(),
}).strict()
type PilotConfig = z.infer<typeof configSchema>
const hash = (value: unknown): string => new Bun.CryptoHasher('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const procedureOperations = new Set(['world.procedure.catalog.list', 'world.procedure.document.read'])
const denied = (): Response => Response.json({ error: { code: 'pilot_document_ineligible', message: 'This document class is not eligible in this pilot condition.' } }, { status: 403 })
const rawPrefix = (source: WikiSourceBinding): string => `https://raw.githubusercontent.com/${encodeURIComponent(source.org)}/${encodeURIComponent(source.repo)}/`

/** One experimental source boundary, not a production ACL. Frozen pages are
 * unchanged source bytes. Procedure documents use the real World reader only. */
export const createReferenceEligibilityFetch = (deps: {
  readonly arm: PilotArm; readonly source: WikiSourceBinding; readonly manifest: WikiManifest
  readonly pages: ReadonlyMap<string, string>; readonly workspaceUrl: string
  readonly fetchImpl: typeof fetch
  readonly observe?: (url: string, operation: string | undefined, status: number) => void
}): typeof fetch => {
  reviewedWikiPages(deps.manifest, [...deps.pages.keys()])
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  const url = request.url
  const wiki = deps.arm === 'wiki' || deps.arm === 'both'
  const procedures = deps.arm === 'procedures' || deps.arm === 'both'
  const operation = url.startsWith(`${deps.workspaceUrl}/capabilities/`) && url.endsWith('/invoke')
    ? decodeURIComponent(url.slice(`${deps.workspaceUrl}/capabilities/`.length, -'/invoke'.length)) : undefined
  let response: Response
  if (operation !== undefined && procedureOperations.has(operation) && !procedures) response = denied()
  else if (url === deps.source.manifestUrl) response = Response.json({
    version: 1, wiki: deps.manifest.wiki, revision: deps.manifest.revision, procedures: [],
    pages: wiki ? deps.manifest.pages.filter(page => deps.pages.has(page.file)) : [],
  })
  else if (url.startsWith(rawPrefix(deps.source))) {
    const expectedPrefix = `${rawPrefix(deps.source)}${deps.manifest.revision}/`
    const file = url.startsWith(expectedPrefix) ? url.slice(expectedPrefix.length).split('/').map(decodeURIComponent).join('/') : ''
    response = wiki && deps.pages.has(file) ? new Response(deps.pages.get(file)!) : denied()
  } else response = await deps.fetchImpl(request)
  if (operation !== undefined && procedureOperations.has(operation) && response.ok) {
    const body = await response.clone().json() as { result?: { source?: { revision?: string } } }
    if (body.result?.source?.revision !== deps.manifest.revision) response = Response.json({ error: {
      code: 'pilot_source_changed', message: 'World procedure source differs from the frozen pilot revision; invalidate this block.',
    } }, { status: 409 })
  }
  deps.observe?.(url, operation, response.status)
  return response
  }) as typeof fetch
}

export const reviewedWikiPages = (manifest: WikiManifest, files: readonly string[]) => {
  if (new Set(files).size !== files.length) throw new Error('Duplicate reviewed wiki file')
  const procedures = new Set(manifest.procedures.map(page => page.file))
  return files.map(file => {
    const page = manifest.pages.find(candidate => candidate.file === file)
    if (!page || procedures.has(file) || page.type === 'procedure') throw new Error(`Not a non-procedure manifest page: ${file}`)
    return page
  })
}

export const pilotOrder = (seed: number): readonly PilotArm[] => {
  let state = seed >>> 0
  return [0, 1].flatMap(() => {
    const arms = [...PILOT_ARMS]
    for (let i = arms.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const j = state % (i + 1)
      ;[arms[i], arms[j]] = [arms[j]!, arms[i]!]
    }
    return arms
  })
}

const dispose = async (runtime: AgentsWorkspaceRuntime): Promise<void> => {
  runtime.triggerScheduler.stop()
  runtime.summaryScheduler.dispose()
  await runtime.resetState()
  runtime.executionStore.close()
}

export const runKnowledgePilot = async (rawConfig: unknown, paid = false): Promise<string> => {
  const config: PilotConfig = configSchema.parse(rawConfig)
  const host = new URL(config.hostOrigin)
  if (host.pathname !== '/' || host.search || host.hash || host.username || host.password) throw new Error('hostOrigin must be an origin without credentials')
  if (config.resource.moduleId !== 'world' || config.resource.type !== 'world.simulation-run') throw new Error('Pilot requires one test-owned World Simulation Run')
  const originalFetch = globalThis.fetch
  const workspaceUrl = `${host.origin}/api/workspaces/${config.resource.workspaceId}`
  const invoke = async (operation: string, input: unknown = {}) => {
    const response = await originalFetch(`${workspaceUrl}/capabilities/${operation}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource: config.resource, input }),
    })
    if (!response.ok) throw new Error(`Pilot preflight ${operation}: HTTP ${response.status}`)
    const body = z.object({ result: z.unknown() }).parse(await response.json())
    return body.result
  }
  const frozenState = async () => {
    const context = z.object({ situation: z.object({ sequence: z.number(), clock: z.unknown(), procedures: z.object({ runs: z.array(z.unknown()) }), execution: z.object({ state: z.object({ playback: z.string(), currentSimulationTime: z.string() }) }) }) }).parse(await invoke('world.simulation-run.context'))
    const { sequence, clock, procedures, execution } = context.situation
    if (execution.state.playback !== 'paused' || procedures.runs.length !== 0) throw new Error('Pilot requires a paused Run with zero live procedure Runs')
    return { sequence, clock, procedures, execution: execution.state }
  }
  const source = PWR_OPS_MANIFEST.wikis[0]!.source!
  const reader = createWikiSource(source)
  const manifest = await reader.fetchManifest()
  const pages = new Map<string, string>()
  for (const page of reviewedWikiPages(manifest, config.wikiFiles)) pages.set(page.file, await reader.fetchDocument(page.file, manifest.revision))
  const definition = getBundledRoomDefinition('leitbild-assistant')!
  const preparation = {
    profile: 'restricted four-tool document-class/route eligibility; not absence of pretrained or overlapping procedure knowledge',
    tools: PILOT_TOOLS, questions: config.questions, model: config.model, temperature: config.temperature,
    reasoningEffort: config.reasoningEffort, seed: config.seed, timeoutMs: config.timeoutMs, maxToolIterations: config.maxToolIterations,
    hostOrigin: host.origin, order: pilotOrder(config.seed), reviewNote: config.reviewNote,
    resource: config.resource, frozenState: await frozenState(), source, manifest,
    wikiPages: [...pages].map(([file, markdown]) => ({ file, hash: hash(markdown), markdown })),
    // Human review must check this for answer keys/embedded guidance; never redact it differently by arm.
    scenarioSource: await invoke('world.simulation-run.scenario-source'),
    procedureCatalog: await invoke('world.procedure.catalog.list'),
    assistant: definition.room.agents[0],
    assistanceSkill: await Bun.file(join(import.meta.dir, '../skills/leitbild-assistance/SKILL.md')).text(),
  }
  const catalog = z.object({ source: z.object({ fetchedAt: z.string(), revision: z.literal(manifest.revision), repository: z.literal(`${source.org}/${source.repo}`) }).passthrough() }).passthrough().parse(preparation.procedureCatalog)
  // Retrieval wall time is observation metadata, not a changed corpus revision.
  const preparationHash = hash({ ...preparation, procedureCatalog: { ...catalog, source: { ...catalog.source, fetchedAt: null } } })
  const output = resolve(config.outputDirectory)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
  if (!paid) { await save('preparation.json', { preparationHash, ...preparation }); return output }
  if (config.approvedPreparationHash !== preparationHash) throw new Error('Preparation changed or is not approved; run preparation into a new directory and review before paid execution')
  const stack = await buildProviderStack()
  try {
  const skills = await loadSkills(join(import.meta.dir, '../skills'), stack.deployment.sharedSkillStore, stack.deployment.sharedToolRegistry)
  if (skills.errors.length || !stack.deployment.sharedSkillStore.get('leitbild-assistance')) throw new Error('Required assistance skill did not load cleanly')
  // This isolated composition pins one model without modifying providers.json
  // or the shared router. A primary-only explicit chain uses existing policy.
  const deployment = { ...stack.deployment, providerPolicy: { getModelFallback: () => [config.model], setModelFallback: async () => { throw new Error('Pilot policy is fixed') } } }
  await save('run-preparation.json', { preparationHash, ...preparation })
  for (const [index, arm] of pilotOrder(config.seed).entries()) {
    const transport: unknown[] = []
    const operations = new Set<Promise<unknown>>()
    let invalidSource = false
    let runtime: AgentsWorkspaceRuntime | undefined
    try {
      globalThis.fetch = createReferenceEligibilityFetch({ arm, source, manifest, pages, workspaceUrl,
        observe: (url, operation, status) => { transport.push({ url, operation, status }); if (operation && procedureOperations.has(operation) && status === 409) invalidSource = true },
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
          if (request.method === 'POST' && !request.url.startsWith(workspaceUrl)) {
            const body = await request.clone().json() as { model?: string; tools?: Array<{ function: { name: string } }> }
            if (!request.url.startsWith('https://openrouter.ai/api/v1/') || body.model !== config.model.slice('openrouter:'.length)) throw createLLMRequestError('pilot_model_changed', 'Pilot permits only the explicitly selected OpenRouter model')
            if (JSON.stringify(body.tools?.map(tool => tool.function.name).sort()) !== JSON.stringify([...PILOT_TOOLS].sort())) throw createLLMRequestError('pilot_tool_surface_changed', 'Pilot tool surface changed')
            transport.push({ wireRequest: body }) // Exact body, never credential-bearing headers.
          }
          return originalFetch(request)
        }) as typeof fetch,
      })
      if (hash(await frozenState()) !== hash(preparation.frozenState)) throw new Error('Frozen Run changed before conversation')
      runtime = createAgentsWorkspaceRuntime({ deployment, workspaceId: config.resource.workspaceId, workspaceHostUrl: host.origin,
        runWorkspaceOperation: async work => { const pending = work(); operations.add(pending); try { return await pending } finally { operations.delete(pending) } },
      })
      const room = runtime.rooms.createRoom({ name: 'Reference pilot', createdBy: 'pilot', scope: { kind: 'resource', resource: config.resource } })
      room.setDeliveryMode('manual')
      room.setActivePacks(['pwr-ops'])
      const agent = asAIAgent(await runtime.spawnAIAgent({ ...definition.room.agents[0]!,
        model: config.model, temperature: config.temperature, seed: config.seed,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        tools: PILOT_TOOLS, skills: ['leitbild-assistance'], maxToolIterations: config.maxToolIterations,
      }))!
      await runtime.addAgentToRoom(agent.id, room.profile.id)
      const surface = await buildToolSupport(PILOT_TOOLS, runtime.toolRegistry, { id: agent.id, name: agent.name }, runtime.llm, id => runtime!.rooms.getRoom(id))
      if (JSON.stringify(surface.resolveToolDefinitions!(room.profile.id)!.map(tool => tool.function.name).sort()) !== JSON.stringify([...PILOT_TOOLS].sort())) throw new Error('Selected tool surface differs')
      const events: unknown[] = []
      let outcome: string | undefined
      runtime.addEvalEventListener((scope, event) => {
        if (event.kind !== 'thinking' && event.kind !== 'chunk') events.push({ scope, event })
        if (event.kind === 'eval_completed') outcome = event.outcome
        if (event.kind === 'tool_iteration_checkin') agent.cancelGeneration()
      })
      let failure: string | undefined
      try {
        for (const question of config.questions) {
          outcome = undefined
          room.post({ senderId: 'pilot-human', senderName: 'You', content: question, type: 'chat' })
          if (!runtime.activateAgentInRoom(agent.id, room.profile.id).ok) throw new Error('Manual Agent activation failed')
          await agent.whenIdle(config.timeoutMs)
          if (invalidSource) throw new Error('Procedure corpus changed; invalidate block')
          if (outcome !== 'respond') throw new Error(`Incomplete turn: ${outcome ?? 'no completion event'}`)
          if (hash(await frozenState()) !== hash(preparation.frozenState)) throw new Error('Frozen Run changed during conversation; invalidate block')
        }
      } catch (error) { failure = error instanceof Error ? error.message : String(error); agent.cancelGeneration(); await agent.whenIdle() }
      await Promise.allSettled([...operations]) // Preserve late real outcomes before evidence export/close.
      const turns = runtime.executionStore.listTurns(room.profile.id, { limit: 100 }).map(turn => ({ ...turn,
        calls: runtime!.executionStore.listCalls(room.profile.id, turn.id).map(call => runtime!.executionStore.getCall(room.profile.id, turn.id, call.id)),
      }))
      let after: unknown
      try { after = await frozenState() } catch (error) { failure ??= String(error); after = { error: String(error) } }
      await save(`conversation-${index + 1}-${arm}.json`, { block: Math.floor(index / 4) + 1, arm, preparationHash, failure, transport, events,
        messages: room.getRetainedMessages(), queries: room.getGenerationQueries(), turns, after })
      if (failure) throw new Error(failure)
    } finally { try { await Promise.allSettled([...operations]); if (runtime) await dispose(runtime) } finally { globalThis.fetch = originalFetch } }
  }
  return output
  } finally { stack.deployment.providerSetup.dispose() }
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file || process.argv.slice(3).some(arg => arg !== '--run')) throw new Error('Usage: bun run experiments/knowledge-pilot.ts config.json [--run]; preparation is read-only, --run incurs model cost')
  console.log(await runKnowledgePilot(await Bun.file(file).json(), process.argv.includes('--run')))
}
