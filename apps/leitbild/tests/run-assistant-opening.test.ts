import { expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createRunAssistantOpening } from '../src/ui/run-assistant-opening.ts'

const workspaceId = newWorkspaceId()
const run = (id: string, workspace = workspaceId) => workspaceResourceReferenceSchema.parse({ workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id })
const room = (id: string, workspace = workspaceId) => workspaceResourceReferenceSchema.parse({ workspaceId: workspace, moduleId: 'agents', type: 'agents.room', id })

test('same exact Run deduplicates while a new Run never borrows the prior deferred resolution or selects its UI', async () => {
  const a = run('a'), b = run('b'), gateA = Promise.withResolvers<void>(), gateB = Promise.withResolvers<void>()
  let current: typeof a | null = a
  const admitted: string[] = [], selected: string[] = []
  const open = createRunAssistantOpening({ current: () => current, resolve: async (expected, assertCurrent) => {
    admitted.push(expected.id)
    await (expected.id === 'a' ? gateA.promise : gateB.promise)
    assertCurrent() // This is the mandatory boundary before the caller changes visible selection.
    selected.push(expected.id)
    return { run: expected, room: room(`room-${expected.id}`) }
  } })
  const first = open(), repeated = open()
  expect(repeated === first).toBe(true)
  expect(admitted).toEqual(['a'])
  current = b
  const next = open()
  expect(next === first).toBe(false)
  expect(admitted).toEqual(['a', 'b'])
  gateB.resolve()
  expect((await next).run.id).toBe('b')
  gateA.resolve(); await expect(first).rejects.toThrow('Run changed')
  expect(selected).toEqual(['b'])
})

test('Workspace identity is part of the pending key even when the Run id is identical', async () => {
  const firstWorkspace = workspaceId, secondWorkspace = newWorkspaceId()
  const gates = new Map([[firstWorkspace, Promise.withResolvers<void>()], [secondWorkspace, Promise.withResolvers<void>()]])
  let current = run('same-id', firstWorkspace), calls = 0
  const open = createRunAssistantOpening({ current: () => current, resolve: async expected => {
    calls++; await gates.get(expected.workspaceId)!.promise
    return { run: expected, room: room('same-room-id', expected.workspaceId) }
  } })
  const first = open(); current = run('same-id', secondWorkspace); const next = open()
  expect(calls).toBe(2)
  gates.get(secondWorkspace)!.resolve()
  expect((await next).room.workspaceId).toBe(secondWorkspace)
  gates.get(firstWorkspace)!.resolve(); await expect(first).rejects.toThrow('Run changed')
})

test('a resolver cannot substitute another Run or a Room from another Workspace', async () => {
  for (const result of [{ run: run('other'), room: room('a') }, { run: run('a'), room: room('a', newWorkspaceId()) }]) {
    const open = createRunAssistantOpening({ current: () => run('a'), resolve: async () => result })
    await expect(open()).rejects.toThrow('does not name this Run')
  }
  let called = false
  const absent = createRunAssistantOpening({ current: () => null, resolve: async () => { called = true; return { run: run('a'), room: room('a') } } })
  await expect(absent()).rejects.toThrow('No Run')
  expect(called).toBe(false)
})
