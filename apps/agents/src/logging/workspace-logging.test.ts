import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { makeStubSetup, makeStubGateway, stubProviderConfig } from '../api/__fixtures__/stub-gateway.ts'
import type { AIAgent } from '../core/types/agent.ts'

test('two Workspaces in one study session use separate files and stable actor/Room/turn identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'leitbild-workspace-logging-'))
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(makeStubGateway()) })
  const one = createAgentsWorkspaceRuntime({ deployment, workspaceLabel: 'workspace-one' })
  const two = createAgentsWorkspaceRuntime({ deployment, workspaceLabel: 'workspace-two' })
  try {
    for (const runtime of [one, two]) {
      await runtime.logging.configure({ enabled: true, dir, sessionId: 'one-study', kinds: ['*'] })
      const room = runtime.rooms.createRoom({ name: 'Same Room', createdBy: 'test' })
      const agent = await runtime.spawnAIAgent({ name: 'Same Agent', model: 'mock-model', persona: 'Answer' }) as AIAgent
      await runtime.addAgentToRoom(agent.id, room.profile.id)
      agent.receive({ id: 'question', senderId: 'human', roomId: room.profile.id, content: 'Hello', type: 'chat', timestamp: 1 })
      await agent.whenIdle()
    }
    const paths = [one.logging.get().currentFile!, two.logging.get().currentFile!]
    expect(paths[0]).not.toBe(paths[1])
    await Promise.all([one.logging.configure({ enabled: false }), two.logging.configure({ enabled: false })])
    for (const [index, path] of paths.entries()) {
      const events = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(new Set(events.map(event => event.workspaceId))).toEqual(new Set([index === 0 ? 'workspace-one' : 'workspace-two']))
      const evaluation = events.find(event => event.kind === 'agent.eval_event' && event.payload.event.traceId)
      expect(evaluation.actor.id).toBe((index === 0 ? one : two).team.getAgent('Same Agent')!.id)
      expect(evaluation.roomId).toBe((index === 0 ? one : two).rooms.getRoom('Same Room')!.profile.id)
    }
  } finally {
    for (const runtime of [one, two]) { await runtime.logging.configure({ enabled: false }); runtime.triggerScheduler.stop(); runtime.summaryScheduler.dispose(); await runtime.comparisons.close(); runtime.executionStore.close() }
    await rm(dir, { recursive: true, force: true })
  }
})
