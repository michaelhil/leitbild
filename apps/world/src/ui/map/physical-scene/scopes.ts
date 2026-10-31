import type { PhysicalSceneScope } from '../../../core/packs/scene.ts'

const memberships = new WeakMap<ReadonlyArray<PhysicalSceneScope>, Map<string, ReadonlySet<string>>>()
/** Navigation areas compose physical scopes without reparenting occurrences. */
export const physicalScopeMembers = (scopes: ReadonlyArray<PhysicalSceneScope>, scopeId: string): ReadonlySet<string> => {
  let cached = memberships.get(scopes)
  if (!cached) { cached = new Map(); memberships.set(scopes, cached) }
  const existing = cached.get(scopeId)
  if (existing) return existing
  const byId = new Map(scopes.map(scope => [scope.id, scope])), selected = byId.get(scopeId)
  const roots = new Set(selected?.kind === 'area' ? selected.members : [scopeId]), result = new Set<string>([scopeId])
  for (const scope of scopes) {
    const seen = new Set<string>()
    let current: string | undefined = scope.id
    while (current !== undefined && !seen.has(current)) {
      if (roots.has(current)) { result.add(scope.id); break }
      seen.add(current); current = byId.get(current)?.parentId
    }
  }
  cached.set(scopeId, result)
  return result
}
