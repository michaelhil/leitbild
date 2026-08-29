const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const currentWorkspaceId = (): string => {
  if (typeof location === 'undefined') throw new Error('Samsinn Workspace URL is unavailable')
  const match = location.pathname.match(/^\/workspaces\/([^/]+)$/)
  const value = match ? decodeURIComponent(match[1] ?? '') : ''
  if (!workspaceIdPattern.test(value)) {
    throw new Error('Samsinn Workspace URL is missing or invalid')
  }
  return value
}

const isDeploymentPath = (path: string): boolean =>
  path === '/auth'
  || path === '/system/info'
  || path === '/system/diagnostics'
  || path === '/workspaces'
  || path.startsWith('/workspaces/')
  || path === '/packs'
  || path.startsWith('/packs/')

export const apiPath = (path: string): string => {
  if (!path.startsWith('/')) throw new Error(`API path must start with /: ${path}`)
  return isDeploymentPath(path)
    ? `/api${path}`
    : `/api/workspaces/${currentWorkspaceId()}${path}`
}

export const apiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (typeof input !== 'string') return fetch(input, init)
  return fetch(input.startsWith('/') ? apiPath(input) : input, init)
}

export const workspaceRealtimeUrl = (sessionToken: string): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = new URLSearchParams()
  if (sessionToken) query.set('session', sessionToken)
  const suffix = query.size > 0 ? `?${query}` : ''
  return `${protocol}//${location.host}/api/workspaces/${currentWorkspaceId()}/ws${suffix}`
}
