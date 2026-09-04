import type {
  ModuleResourceDescriptor,
  WorkspaceResourceReference,
  WorkspaceResourceSubjectSelection,
} from '@leitbild/contracts'

export const sameResource = (left: WorkspaceResourceReference, right: WorkspaceResourceReference): boolean =>
  left.workspaceId === right.workspaceId
  && left.moduleId === right.moduleId
  && left.type === right.type
  && left.id === right.id

export const runFamilyFor = (run: ModuleResourceDescriptor): WorkspaceResourceReference | undefined =>
  run.links.find(link => link.rel === 'member-of' && link.ref.type === 'world.run-family')?.ref

export const roomUsesFamily = (room: ModuleResourceDescriptor, family: WorkspaceResourceReference): boolean =>
  room.links.some(link => link.rel === 'subject-collection' && sameResource(link.ref, family))

export const roomSelectsRun = (room: ModuleResourceDescriptor, run: ModuleResourceDescriptor): boolean => {
  const family = runFamilyFor(run)
  if (!family || !roomUsesFamily(room, family)) return false
  const selected = room.links.filter(link => link.rel === 'subject-member')
  if (selected.length > 0) return selected.some(link => sameResource(link.ref, run.ref))
  return !room.links.some(link => link.rel === 'subject-excluded' && sameResource(link.ref, run.ref))
}

export const roomSelectionIncludingRun = (
  room: ModuleResourceDescriptor,
  family: WorkspaceResourceReference,
  run: WorkspaceResourceReference,
): WorkspaceResourceSubjectSelection => {
  const selected = room.links.filter(link => link.rel === 'subject-member').map(link => link.ref)
  if (selected.length > 0) {
    return {
      kind: 'collection',
      collection: family,
      members: { mode: 'selected', only: selected.some(ref => sameResource(ref, run)) ? selected : [...selected, run] },
    }
  }
  return {
    kind: 'collection',
    collection: family,
    members: {
      mode: 'all',
      except: room.links.filter(link => link.rel === 'subject-excluded' && !sameResource(link.ref, run)).map(link => link.ref),
    },
  }
}
