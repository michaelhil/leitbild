import { describe, expect, test } from 'bun:test'
import { moduleResourceDescriptorSchema, newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { roomScopeIncludingRun, roomSelectsRun, sameResource } from '../src/ui/run-room-scope.ts'

const workspaceId = newWorkspaceId()
const observedAt = new Date().toISOString()
const runRef = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'shared-id' })
const familyRef = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.run-family', id: 'shared-id' })
const run = moduleResourceDescriptorSchema.parse({
  ref: runRef,
  title: 'Original',
  links: [{ rel: 'member-of', ref: familyRef }],
  capabilityIds: [], summary: [], observedAt,
})
const room = (subjectLinks: unknown[]) => moduleResourceDescriptorSchema.parse({
  ref: { workspaceId, moduleId: 'agents', type: 'agents.room', id: crypto.randomUUID() },
  title: 'Assistant', links: subjectLinks, capabilityIds: [], summary: [], observedAt,
})

describe('Run Room scope', () => {
  test('compares complete Resource identity when family and original share an id', () => {
    expect(sameResource(run.ref, familyRef)).toBe(false)
    expect(roomSelectsRun(room([{ rel: 'scope-collection', ref: familyRef }]), run)).toBe(true)
  })

  test('supports dynamic all-except and fixed selected-only links', () => {
    expect(roomSelectsRun(room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-excluded', ref: runRef },
    ]), run)).toBe(false)
    expect(roomSelectsRun(room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-member', ref: runRef },
    ]), run)).toBe(true)
  })

  test('explicit reopening restores one excluded Run without changing future-copy policy', () => {
    const other = workspaceResourceReferenceSchema.parse({ ...run.ref, id: 'other' })
    const dynamicRoom = room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-excluded', ref: run.ref },
      { rel: 'scope-excluded', ref: other },
    ])
    expect(roomScopeIncludingRun(dynamicRoom, familyRef, run.ref)).toEqual({
      kind: 'collection',
      collection: familyRef,
      members: { mode: 'all', except: [other] },
    })

    const fixedRoom = room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-member', ref: other },
    ])
    expect(roomScopeIncludingRun(fixedRoom, familyRef, run.ref)).toEqual({
      kind: 'collection',
      collection: familyRef,
      members: { mode: 'selected', only: [other, run.ref] },
    })
  })
})
