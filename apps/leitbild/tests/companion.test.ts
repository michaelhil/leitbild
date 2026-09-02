import { expect, test } from 'bun:test'
import { moduleDefinitionDescriptorSchema, moduleResourceDescriptorSchema, newWorkspaceId, resourceIdSchema } from '@leitbild/contracts'
import { openCompanion } from '../src/ui/companion.ts'

const workspaceId = newWorkspaceId()
const world = moduleResourceDescriptorSchema.parse({ ref: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' }, title: 'Run', capabilityIds: [], observedAt: new Date().toISOString() })
const room = moduleResourceDescriptorSchema.parse({ ref: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room' }, title: 'Room', capabilityIds: [], links: [{ rel: 'companion-of', ref: world.ref }], observedAt: new Date().toISOString() })
const definition = moduleDefinitionDescriptorSchema.parse({ ref: { workspaceId, moduleId: 'agents', type: 'agents.room-definition', id: 'custom' }, title: 'Custom', currentRevisionId: 'revision-one', capabilityIds: ['agents.custom.ensure'], companion: { resourceType: world.ref.type, capabilityId: 'agents.custom.ensure' } })

test('existing companions outlive their deleted templates; associations are exact', async () => {
  expect(await openCompanion(world, [], [room])).toEqual(room.ref)
  await expect(openCompanion({ ...world, ref: { ...world.ref, id: resourceIdSchema.parse('another') } }, [], [room])).rejects.toThrow('No companion definition')
  await expect(openCompanion(world, [], [room, { ...room, ref: { ...room.ref, id: resourceIdSchema.parse('duplicate') } }])).rejects.toThrow('Multiple companion rooms')
})

test('missing and ambiguous definitions fail visibly instead of guessing', async () => {
  await expect(openCompanion(world, [], [])).rejects.toThrow('No companion definition')
  await expect(openCompanion(world, [definition, definition], [])).rejects.toThrow('Multiple companion definitions')
})

test('invokes discovered capability with pinned revision, exact resource and validated result', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const transport = (async (path: string, options: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(options.body)) })
    return { result: { resource: room.ref } }
  }) as Parameters<typeof openCompanion>[3]
  expect(await openCompanion(world, [definition], [], transport)).toEqual(room.ref)
  expect(calls[0]?.path).toEndWith('/capabilities/agents.custom.ensure/invoke')
  expect(calls[0]?.body).toEqual({ definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: { resource: world.ref, title: world.title }, actor: { kind: 'human' } })
  expect(() => moduleDefinitionDescriptorSchema.parse({ ...definition, companion: { resourceType: world.ref.type, capabilityId: 'world.wrong' } })).toThrow()
})
