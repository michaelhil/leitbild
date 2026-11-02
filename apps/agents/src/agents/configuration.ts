import { z } from 'zod'
import { REASONING_EFFORTS } from '../core/types/llm.ts'
import type { Team } from '../core/types/agent.ts'
import { createSerialiseChain, type SerialiseChain } from '../core/serialise-chain.ts'

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
