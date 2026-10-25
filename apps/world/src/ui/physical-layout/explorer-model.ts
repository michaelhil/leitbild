import type { PhysicalSceneObject, PhysicalSceneScope } from '../../core/packs/scene.ts'
import type { PhysicalSceneDescriptor, PhysicalSceneView } from '../map/physical-scene/types.ts'

export interface ExplorerScopeChoice {
  readonly key: string
  readonly sceneId: string | null
  readonly groupId?: string
  readonly sceneIds?: ReadonlyArray<string>
  readonly scopeId?: string
  readonly label: string
  readonly path: string
  readonly depth: number
  readonly kind: string
}

/** Authored hierarchy only: membership is never guessed from a label or mesh shape. */
export const explorerScopeChoices = (descriptor: PhysicalSceneDescriptor, label: string): ReadonlyArray<ExplorerScopeChoice> => {
  const scopes = descriptor.scopes ?? []
  const byId = new Map(scopes.map(scope => [scope.id, scope]))
  const pathOf = (scope: PhysicalSceneScope): string[] => {
    const seen = new Set<string>()
    const labels: string[] = []
    let current: PhysicalSceneScope | undefined = scope
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id); labels.unshift(current.label)
      current = current.parentId === undefined ? undefined : byId.get(current.parentId)
    }
    return labels[0] === label ? labels : [label, ...labels]
  }
  return [{ key: descriptor.id, sceneId: descriptor.id, label, path: label, depth: 0, kind: 'layout' }, ...scopes.map(scope => {
    const path = pathOf(scope)
    return { key: `${descriptor.id}/${scope.id}`, sceneId: descriptor.id, scopeId: scope.id, label: scope.label, path: path.join(' / '), depth: path.length - 1, kind: scope.kind }
  })]
}

export const physicalOccurrenceInScope = (object: Pick<PhysicalSceneObject, 'scopeIds'>, scopeId: string | null, scopes: ReadonlyArray<PhysicalSceneScope>): boolean => {
  if (scopeId === null) return true
  const byId = new Map(scopes.map(scope => [scope.id, scope]))
  return (object.scopeIds ?? []).some(id => {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current !== undefined && !seen.has(current)) {
      if (current === scopeId) return true
      seen.add(current); current = byId.get(current)?.parentId
    }
    return false
  })
}

/** A spanning assembly can remain on any declared intersecting floor. */
export const physicalOccurrenceOnLevel = (object: Pick<PhysicalSceneObject, 'levelId' | 'levelIds'>, levelId: string): boolean =>
  levelId === 'all' || object.levelId === 'site' || (object.levelIds ?? [object.levelId]).includes(levelId)

export const levelForPhysicalFocus = (object: Pick<PhysicalSceneObject, 'levelId' | 'levelIds'>, current: PhysicalSceneView): string | null => {
  if (current.mode === '3d' && current.levelId === 'all' || physicalOccurrenceOnLevel(object, current.levelId)) return current.levelId
  const levels = object.levelIds ?? (object.levelId === 'site' ? [] : [object.levelId])
  return levels.length === 1 ? levels[0]! : null
}

/** Preserve a valid section; a multi-floor area requires the user's choice. */
export const levelForScopeFocus = (levelIds: ReadonlyArray<string>, current: PhysicalSceneView): string | null => {
  if (current.mode === '3d' && current.levelId === 'all' || levelIds.length === 0 || levelIds.includes(current.levelId)) return current.levelId
  return levelIds.length === 1 ? levelIds[0]! : null
}
