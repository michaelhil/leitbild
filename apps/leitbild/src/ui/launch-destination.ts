// Canonical Workspace URLs. Identity is in the path; the query only selects
// what the Workspace shell shows (`world` Run, `agents` conversation).

export interface CreatedResourceRef {
  readonly moduleId: string
  readonly type: string
  readonly id: string
}

export interface WorkspaceSelection {
  readonly world?: string | null
  readonly agents?: string | null
  readonly planning?: string | null
}

export const workspacePath = (workspaceId: string): string => `/workspaces/${encodeURIComponent(workspaceId)}`

export const workspaceUrl = (workspaceId: string, selection: WorkspaceSelection = {}): string => {
  const params = new URLSearchParams()
  if (selection.world) params.set('world', selection.world)
  if (selection.agents) params.set('agents', selection.agents)
  if (selection.planning) params.set('planning', selection.planning)
  return `${workspacePath(workspaceId)}${params.size > 0 ? `?${params}` : ''}`
}

/**
 * Where to go after a Capability created Resources: a created Run opens in the
 * World pane, a created conversation in the Agents pane. Without a created Run
 * the current Run stays; the current conversation stays only when no Run was
 * created (a new Run must not inherit another Run's conversation).
 */
export const launchDestination = (
  workspaceId: string,
  created: ReadonlyArray<CreatedResourceRef>,
  current: WorkspaceSelection = {},
): string => {
  const world = created.find(resource => resource.moduleId === 'world' && resource.type === 'world.simulation-run')
  const agents = created.find(resource => resource.moduleId === 'agents' && resource.type === 'agents.room')
  const study = created.find(resource => resource.moduleId === 'planning' && resource.type === 'planning.study')
  return workspaceUrl(workspaceId, {
    world: study ? null : world?.id ?? current.world ?? null,
    agents: agents?.id ?? (world || study ? null : current.agents ?? null),
    planning: study?.id ?? (world ? null : current.planning ?? null),
  })
}
