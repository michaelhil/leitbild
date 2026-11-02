import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubSetup, makeStubGateway, stubProviderConfig } from '../api/__fixtures__/stub-gateway.ts'
import { loadSkills } from './loader.ts'
import type { AIAgent } from '../core/types/agent.ts'

test('bundled loading retires the unused global KB and old selections receive visible diagnostics without aliases', async () => {
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(makeStubGateway()) })
  await loadSkills(join(import.meta.dir, '../../skills'), deployment.sharedSkillStore, deployment.sharedToolRegistry)
  expect(deployment.sharedSkillStore.get('knowledge-base')).toBeUndefined()
  for (const name of ['kb_ingest', 'kb_query', 'kb_lint']) expect(deployment.sharedToolRegistry.has(name)).toBe(false)
  expect(deployment.sharedSkillStore.get('leitbild-assistance')).toBeDefined()
  const runtime = createAgentsWorkspaceRuntime({ deployment })
  const warnings: string[] = []
  runtime.setOnEvalEvent((_scope, event) => { if (event.kind === 'warning') warnings.push(event.message) })
  try {
    const room = runtime.rooms.createRoom({ name: 'Restored selection', createdBy: 'test' })
    // Restoration keeps strict saved selections; it neither migrates nor
    // silently replaces a retired tool with an unrelated knowledge source.
    const agent = await runtime.spawnAIAgent({ name: 'Old Profile', model: 'mock-model', persona: 'Help', tools: ['kb_ingest'], skills: ['knowledge-base'], includeTools: false }) as AIAgent
    await runtime.addAgentToRoom(agent.id, room.profile.id)
    agent.receive({ id: 'question', roomId: room.profile.id, senderId: 'person', content: 'Status?', type: 'chat', timestamp: 1 })
    await agent.whenIdle()
    expect(warnings.some(message => message.includes('kb_ingest') && message.includes('unavailable or retired'))).toBe(true)
    expect(warnings.some(message => message.includes('knowledge-base') && message.includes('unavailable or retired'))).toBe(true)
    expect(agent.getConfig()).toMatchObject({ tools: ['kb_ingest'], skills: ['knowledge-base'] })
  } finally { runtime.triggerScheduler.stop(); runtime.summaryScheduler.dispose(); await runtime.comparisons.close(); runtime.executionStore.close() }
})
