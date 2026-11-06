import { z } from 'zod'
import { REASONING_EFFORTS } from '../core/types/llm.ts'
import type { Team } from '../core/types/agent.ts'
import { createSerialiseChain, type SerialiseChain } from '../core/serialise-chain.ts'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { actorContextSchema, type ActorContext } from '@leitbild/contracts'
import type { AIAgent, AIAgentConfig } from '../core/types/agent.ts'
import type { ToolRegistry } from '../core/types/tool.ts'
import type { SkillStore } from '../skills/loader.ts'
import { asAIAgent } from './shared.ts'

const names = z.array(z.string().trim().min(1))
export const agentConfigurationPatchSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  persona: z.string().max(64_000).optional(),
  description: z.string().max(64_000).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  historyLimit: z.number().int().positive().optional(),
  historyTokenBudget: z.number().int().positive().nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional(),
  thinking: z.boolean().optional(),
  tools: names.optional(), skills: names.optional(), tags: names.optional(),
  includePrompts: z.object({ persona: z.boolean().optional(), room: z.boolean().optional(), workspace: z.boolean().optional(), responseFormat: z.boolean().optional(), skills: z.boolean().optional(), wikis: z.boolean().optional() }).strict().optional(),
  includeContext: z.object({ participants: z.boolean().optional(), activity: z.boolean().optional(), knownAgents: z.boolean().optional() }).strict().optional(),
  includeTools: z.boolean().optional(), promptsEnabled: z.boolean().optional(), contextEnabled: z.boolean().optional(),
  maxToolIterations: z.number().int().positive().nullable().optional(),
}).strict()

// Configuration mutations share one Workspace owner, including human renames.
// Failed validation has no state/event/storage side effects, and an async model
// status lookup cannot interleave two accepted edits.
const updates = new WeakMap<Team, SerialiseChain>()
export const withAgentConfigurationUpdate = <T>(team: Team, work: () => Promise<T>): Promise<T> => {
  let chain = updates.get(team)
  if (!chain) { chain = createSerialiseChain(); updates.set(team, chain) }
  return chain.run(work)
}

export const agentProfileChangesSchema = agentConfigurationPatchSchema.omit({ name: true, description: true })
export const agentConfigurationUpdateSchema = z.object({ expectedRevision: z.string().regex(/^configuration-[a-f0-9]{64}$/), changes: agentProfileChangesSchema }).strict()
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)])) : value
export const agentConfigurationRevision = (config: AIAgentConfig): string => `configuration-${createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex')}`
const refusal = (code: string, message: string, details?: unknown): never => { throw Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) }) }

const receiptSchema = z.object({
  id: z.string().uuid(), ordinal: z.number().int().positive(), at: z.iso.datetime(),
  targetId: z.string().min(1), actor: actorContextSchema,
  beforeRevision: z.string(), afterRevision: z.string(), outcome: z.literal('saved'),
  changes: z.record(z.string(), z.object({ before: z.unknown().optional(), after: z.unknown().optional() }).strict()),
}).strict()
export type AgentConfigurationReceipt = z.infer<typeof receiptSchema>

/** Specific configuration provenance, not Definition history or model execution.
 * Immutable receipts share Workspace storage admission. They are retained until
 * that Workspace is deleted; full storage refuses before adding a receipt.
 */
export const createConfigurationReceipts = (directory?: string, growth: <T>(bytes: number, work: () => Promise<T>) => Promise<T> = (_bytes, work) => work()) => {
  const latest = new Map<string, AgentConfigurationReceipt>()
  const ownerPath = (id: string): string => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid configuration target identity')
    return join(directory!, id)
  }
  const readLatest = async (targetId: string): Promise<AgentConfigurationReceipt | undefined> => {
    if (!directory) return latest.get(targetId) // Explicitly ephemeral standalone runtime.
    let files: string[]
    try { files = await readdir(ownerPath(targetId)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const path = files.filter(file => /^receipt-\d+\.json$/.test(file)).sort().at(-1)
    if (!path) return undefined
    const receipt = receiptSchema.parse(JSON.parse(await readFile(join(ownerPath(targetId), path), 'utf8')))
    if (receipt.targetId !== targetId) throw new Error('Configuration receipt belongs to another Agent')
    return receipt
  }
  return {
    readLatest,
    save: async (input: Omit<AgentConfigurationReceipt, 'ordinal'>): Promise<AgentConfigurationReceipt> => {
      const previous = await readLatest(input.targetId)
      const receipt = receiptSchema.parse({ ...input, ordinal: (previous?.ordinal ?? 0) + 1 })
      if (!directory) { latest.set(input.targetId, receipt); return receipt }
      const text = JSON.stringify(receipt)
      await growth(Buffer.byteLength(text) + 4096, async () => {
        const root = ownerPath(input.targetId)
        await mkdir(root, { recursive: true })
        const temporary = join(root, `.${receipt.id}.tmp`)
        try {
          await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          await rename(temporary, join(root, `receipt-${String(receipt.ordinal).padStart(16, '0')}.json`))
        } finally { await rm(temporary, { force: true }) }
      })
      return receipt
    },
  }
}

type Changes = z.infer<typeof agentProfileChangesSchema>
const applyChanges = (agent: AIAgent, changes: Changes): void => {
  if (changes.persona !== undefined) agent.updatePersona(changes.persona)
  if (changes.model !== undefined) agent.updateModel(changes.model)
  if (changes.temperature !== undefined) agent.updateTemperature!(changes.temperature)
  if (changes.historyLimit !== undefined) agent.updateHistoryLimit!(changes.historyLimit)
  if (changes.historyTokenBudget !== undefined) agent.updateHistoryTokenBudget(changes.historyTokenBudget ?? undefined)
  if (changes.reasoningEffort !== undefined) agent.updateReasoningEffort(changes.reasoningEffort ?? undefined)
  if (changes.thinking !== undefined) agent.updateThinking!(changes.thinking)
  if (changes.tools !== undefined) agent.updateTools!([...new Set(changes.tools)])
  if (changes.skills !== undefined) agent.updateSkills([...new Set(changes.skills)])
  if (changes.tags !== undefined) agent.updateTags!([...new Set(changes.tags)])
  if (changes.includePrompts !== undefined) agent.updateIncludePrompts(changes.includePrompts)
  if (changes.includeContext !== undefined) agent.updateIncludeContext(changes.includeContext)
  if (changes.includeTools !== undefined) agent.updateIncludeTools(changes.includeTools)
  if (changes.promptsEnabled !== undefined) agent.updatePromptsEnabled(changes.promptsEnabled)
  if (changes.contextEnabled !== undefined) agent.updateContextEnabled(changes.contextEnabled)
  if (changes.maxToolIterations !== undefined) agent.updateMaxToolIterations(changes.maxToolIterations ?? undefined)
}

export const createAgentConfiguration = (deps: { team: Team; tools: ToolRegistry; skills: SkillStore; refresh: () => Promise<void>; persist: () => Promise<void>; receipts: ReturnType<typeof createConfigurationReceipts>; changed: () => void; durable: boolean }) => {
  const requireAgent = (targetId: string): AIAgent => {
    const agent = deps.team.getAgent(targetId)
    const ai = agent && asAIAgent(agent)
    return ai || refusal('agent_not_found', 'AI Agent not found')
  }
  const read = async (targetId: string) => {
    const agent = requireAgent(targetId), desired = structuredClone(agent.getConfig()), effective = agent.getEffectiveConfig?.()
    return { id: agent.id, desired, revision: agentConfigurationRevision(desired), ...(effective === undefined ? {} : { effective }),
      pending: effective !== undefined && agentConfigurationRevision(effective) !== agentConfigurationRevision(desired),
      applies: 'next-turn' as const, persistence: deps.durable ? 'workspace' as const : 'ephemeral' as const,
      latestReceipt: await deps.receipts.readLatest(agent.id) }
  }
  return {
    read: (targetId: string) => withAgentConfigurationUpdate(deps.team, () => read(targetId)),
    update: (targetId: string, raw: unknown, actor: ActorContext, expectedRevision?: string) => withAgentConfigurationUpdate(deps.team, async () => {
      const changes = agentProfileChangesSchema.parse(raw), sourceActor = actorContextSchema.parse(actor)
      const agent = requireAgent(targetId), before = structuredClone(agent.getConfig()), beforeRevision = agentConfigurationRevision(before)
      if (expectedRevision !== undefined && expectedRevision !== beforeRevision) refusal('configuration_conflict', 'Agent configuration changed; read it again before editing', { currentRevision: beforeRevision })
      const missingTools = changes.tools?.filter(name => !deps.tools.has(name)) ?? []
      const missingSkills = changes.skills?.filter(name => !deps.skills.get(name)) ?? []
      if (missingTools.length || missingSkills.length) refusal('configuration_selection_invalid', `Unknown selections: ${[...missingTools.map(name => `tools.${name}`), ...missingSkills.map(name => `skills.${name}`)].join(', ')}`)
      for (const [field, setter] of [['temperature', 'updateTemperature'], ['historyLimit', 'updateHistoryLimit'], ['thinking', 'updateThinking'], ['tools', 'updateTools'], ['tags', 'updateTags']] as const) {
        if (changes[field] !== undefined && typeof agent[setter] !== 'function') refusal('configuration_field_unsupported', `Agent does not support ${field}`)
      }
      // No await before the complete request and live selections are admitted.
      applyChanges(agent, changes)
      const after = structuredClone(agent.getConfig()), afterRevision = agentConfigurationRevision(after)
      const difference = Object.fromEntries(Object.keys(changes).flatMap(key => JSON.stringify(canonical(before[key as keyof AIAgentConfig])) === JSON.stringify(canonical(after[key as keyof AIAgentConfig])) ? [] : [[key, { before: before[key as keyof AIAgentConfig], after: after[key as keyof AIAgentConfig] }]]))
      let stage = 'runtime'
      try {
        if (changes.tools !== undefined) await deps.refresh()
        stage = 'save'
        await deps.persist()
        stage = 'receipt'
        const receipt = await deps.receipts.save({ id: crypto.randomUUID(), at: new Date().toISOString(), targetId: agent.id, actor: sourceActor, beforeRevision, afterRevision, outcome: 'saved', changes: difference })
        deps.changed()
        return { ...await read(agent.id), receipt }
      } catch (error) {
        return refusal('configuration_outcome_unknown', `Configuration changed in memory but ${stage} did not finish: ${error instanceof Error ? error.message : String(error)}. Read configuration and saved state before retrying.`, { targetId: agent.id, currentRevision: afterRevision, stage })
      }
    }),
  }
}
export type AgentConfiguration = ReturnType<typeof createAgentConfiguration>
