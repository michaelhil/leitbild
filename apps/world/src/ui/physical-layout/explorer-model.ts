import type { PhysicalSceneObject, PhysicalSceneScope } from '../../core/packs/scene.ts'
import type { PhysicalSceneDescriptor, PhysicalSceneView } from '../map/physical-scene/types.ts'
import { levelLabel } from './view.ts'
import { physicalScopeMembers } from '../map/physical-scene/scopes.ts'

export interface ExplorerScopeChoice {
  readonly key: string
  readonly sceneId: string | null
  readonly groupId?: string
  readonly sceneIds?: ReadonlyArray<string>
  readonly scopeId?: string
  readonly parentKey?: string
  readonly levelContext?: string
  readonly label: string
  readonly path: string
  readonly depth: number
  readonly kind: string
}

// Namespace tuple keys avoid collisions between arbitrary source, scope and group IDs.
export const explorerLayoutKey = (sceneId: string, scopeId?: string): string => JSON.stringify(scopeId === undefined ? ['layout', sceneId] : ['scope', sceneId, scopeId])
export const explorerGroupKey = (groupId: string): string => JSON.stringify(['group', groupId])

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
  return [{ key: explorerLayoutKey(descriptor.id), sceneId: descriptor.id, label, path: label, depth: 0, kind: 'layout', ...(descriptor.group ? { parentKey: explorerGroupKey(descriptor.group.id), groupId: descriptor.group.id } : {}) }, ...scopes.map(scope => {
    const path = pathOf(scope)
    const levels = descriptor.levels.filter(level => scope.levelIds.includes(level.id))
    return { key: explorerLayoutKey(descriptor.id, scope.id), sceneId: descriptor.id, scopeId: scope.id,
      ...(descriptor.group ? { groupId: descriptor.group.id } : {}),
      parentKey: scope.parentId === undefined ? explorerLayoutKey(descriptor.id) : explorerLayoutKey(descriptor.id, scope.parentId),
      ...(scope.kind === 'space' && levels.length > 0 ? { levelContext: levels.map(levelLabel).join(' · ') } : {}),
      label: scope.label, path: path.join(' / '), depth: path.length - 1, kind: scope.kind }
  })]
}

export interface ExplorerScopeBranch {
  readonly choice: ExplorerScopeChoice
  readonly hasChildren: boolean
  readonly expanded: boolean
  readonly children: ReadonlyArray<ExplorerScopeBranch>
}

/** Only expanded descendants enter the DOM. Search reveals matches with their authored ancestry. */
export const explorerScopeBranches = (choices: ReadonlyArray<ExplorerScopeChoice>, expanded: ReadonlySet<string>, query = ''): ReadonlyArray<ExplorerScopeBranch> => {
  const byKey = new Map(choices.map(choice => [choice.key, choice]))
  const children = new Map<string | undefined, ExplorerScopeChoice[]>()
  for (const choice of choices) {
    const ancestors = new Set([choice.key]); let parent = choice.parentKey
    while (parent !== undefined) {
      if (ancestors.has(parent)) throw new Error(`Physical area hierarchy contains a cycle at ${choice.label}`)
      ancestors.add(parent); parent = byKey.get(parent)?.parentKey
    }
    if (choice.parentKey !== undefined && !byKey.has(choice.parentKey)) throw new Error(`Physical area parent is unavailable: ${choice.parentKey}`)
    const siblings = children.get(choice.parentKey)
    if (siblings) siblings.push(choice); else children.set(choice.parentKey, [choice])
  }
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const retained = new Set<string>()
  if (words.length > 0) for (const choice of choices) {
    const text = `${choice.label} ${choice.path} ${choice.levelContext ?? ''} ${choice.kind}`.toLocaleLowerCase()
    if (!words.every(word => text.includes(word))) continue
    let current: ExplorerScopeChoice | undefined = choice
    while (current) { retained.add(current.key); current = current.parentKey === undefined ? undefined : byKey.get(current.parentKey) }
  }
  const branch = (choice: ExplorerScopeChoice): ExplorerScopeBranch => {
    const descendants = children.get(choice.key) ?? []
    const open = words.length > 0 || expanded.has(choice.key)
    return { choice, hasChildren: descendants.length > 0, expanded: open,
      children: open ? descendants.filter(child => words.length === 0 || retained.has(child.key)).map(branch) : [] }
  }
  return (children.get(undefined) ?? []).filter(choice => words.length === 0 || retained.has(choice.key)).map(branch)
}

export const explorerScopeAncestors = (choices: ReadonlyArray<ExplorerScopeChoice>, key: string): ReadonlyArray<string> => {
  const byKey = new Map(choices.map(choice => [choice.key, choice])), ancestors: string[] = [], seen = new Set<string>()
  let current: string | undefined = key
  while (current !== undefined && !seen.has(current)) { seen.add(current); ancestors.push(current); current = byKey.get(current)?.parentKey }
  return ancestors
}

export const physicalOccurrenceInScope = (object: Pick<PhysicalSceneObject, 'scopeIds'>, scopeId: string | null, scopes: ReadonlyArray<PhysicalSceneScope>): boolean => {
  if (scopeId === null) return true
  const members = physicalScopeMembers(scopes, scopeId)
  return (object.scopeIds ?? []).some(id => members.has(id))
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
