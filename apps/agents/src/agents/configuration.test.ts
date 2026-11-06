import { expect, test } from 'bun:test'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAIAgent } from './ai-agent.ts'
import { createTeam } from './team.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createSkillStore } from '../skills/loader.ts'
import { createAgentConfiguration, createConfigurationReceipts } from './configuration.ts'

const actor = { kind: 'human' as const, id: 'person-one', displayName: 'Operator' }
const setup = async (options: { saveFailure?: boolean; receiptFailure?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-profile-config-'))
  const team = createTeam(), tools = createToolRegistry(), skills = createSkillStore()
  const agent = createAIAgent({ name: 'Target', model: 'fixture', persona: 'Original' }, { models: async () => ['fixture'], chat: async () => ({ content: 'Done', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }) }, () => {})
  team.addAgent(agent)
  let stored = structuredClone(agent.getConfig()), changed = 0, saves = 0
  const receipts = createConfigurationReceipts(root)
  const configuration = createAgentConfiguration({ team, tools, skills, refresh: async () => {},
    persist: async () => { saves++; if (options.saveFailure) throw new Error('disk unavailable'); stored = structuredClone(agent.getConfig()) },
    receipts: options.receiptFailure ? { ...receipts, save: async () => { throw new Error('receipt unavailable') } } : receipts,
    changed: () => { changed++ }, durable: true })
  return { root, configuration, receipts, agent, tools, stored: () => stored, changed: () => changed, saves: () => saves }
}

test('human and AI writers share one serialized revision check and durable actor-attributed diff', async () => {
  const env = await setup()
  try {
    const original = await env.configuration.read(env.agent.id)
    const outcomes = await Promise.allSettled([
      env.configuration.update(env.agent.id, { persona: 'Human edit' }, actor, original.revision),
      env.configuration.update(env.agent.id, { persona: 'Agent edit' }, { kind: 'ai', id: 'another-agent' }, original.revision),
    ])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failed = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason.code).toBe('configuration_conflict')
    expect(env.changed()).toBe(1)
    expect(env.saves()).toBe(1)
    expect(env.stored().persona).toBe('Human edit')
    const restoredReceipt = await createConfigurationReceipts(env.root).readLatest(env.agent.id)
    expect(restoredReceipt).toMatchObject({ targetId: env.agent.id, actor, outcome: 'saved', beforeRevision: original.revision, changes: { persona: { before: 'Original', after: 'Human edit' } } })
    expect(restoredReceipt!.actor.id).not.toBe(env.agent.id)
    const current = await env.configuration.read(env.agent.id)
    expect(current.revision).toBe(restoredReceipt!.afterRevision)
    expect(current.applies).toBe('next-turn')
    expect(current.pending).toBe(false)
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

test('invalid mixed patches cannot mutate, persist, emit or manufacture a saved receipt', async () => {
  const env = await setup()
  try {
    const before = await env.configuration.read(env.agent.id)
    for (const changes of [{ persona: 'Changed', tools: ['missing'] }, { persona: 'Changed', maxToolIterations: -1 }, { persona: 'Changed', roomScope: 'all' }]) {
      await expect(env.configuration.update(env.agent.id, changes, actor, before.revision)).rejects.toBeDefined()
      expect(env.agent.getPersona()).toBe('Original')
    }
    expect(env.saves()).toBe(0)
    expect(env.changed()).toBe(0)
    expect(await readdir(env.root)).toEqual([])
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

for (const stage of ['save', 'receipt'] as const) test(`${stage} failure reports unknown outcome with current readback and no false saved event`, async () => {
  const env = await setup({ saveFailure: stage === 'save', receiptFailure: stage === 'receipt' })
  try {
    const before = await env.configuration.read(env.agent.id)
    let failure: unknown
    try { await env.configuration.update(env.agent.id, { persona: 'Desired edit' }, actor, before.revision) } catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'configuration_outcome_unknown', details: { stage, targetId: env.agent.id } })
    expect(env.agent.getPersona()).toBe('Desired edit')
    expect(env.stored().persona).toBe(stage === 'save' ? 'Original' : 'Desired edit')
    const after = await env.configuration.read(env.agent.id)
    expect(after.revision).not.toBe(before.revision)
    expect(after.latestReceipt).toBeUndefined()
    expect(env.changed()).toBe(0)
    await expect(env.configuration.update(env.agent.id, { persona: 'Blind retry' }, actor, before.revision)).rejects.toMatchObject({ code: 'configuration_conflict' })
  } finally { await rm(env.root, { recursive: true, force: true }) }
})
