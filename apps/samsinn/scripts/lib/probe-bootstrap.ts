// ============================================================================
// Shared bootstrap for streaming-probe + smoke-streaming.
//
// Both probes need the same first three steps:
//   1. Optionally authenticate (when SAMSINN_TOKEN is set in deploy mode).
//   2. Provision both Samsinn Modules for a fresh Workspace id, or select an
//      already wired Workspace from diagnostics.
//   3. Return canonical URL-scoped API and realtime coordinates.
//
// Centralizing here means both scripts share the SAME Workspace-selection
// behavior. Rules:
//   * The probe MUST use a fresh Workspace, NEVER evict or otherwise
//     interfere with a real user's session.
//   * Workspace identity lives only in canonical URL paths. The Workspace
//     Host normally owns the lifecycle call; this local operational probe
//     calls the same internal Module boundary directly.
// ============================================================================

const SESSION_COOKIE_PREFIX = 'samsinn_session='

export interface ProbeContext {
  readonly baseUrl: string
  readonly wsBaseUrl: string
  readonly cookie: string
  readonly workspaceId: string
  readonly sessionCookie: string | undefined
}

export interface BootstrapOptions {
  readonly baseUrl: string
  // When 'reuse-wired', pick the first wired Workspace from diagnostics.
  // When 'fresh', provision a new Workspace through normal navigation.
  // The post-deploy probe must use 'fresh' to avoid evicting real users.
  readonly target: 'reuse-wired' | 'fresh'
  readonly token?: string
}

export const workspaceApiUrl = (context: ProbeContext, path: `/${string}`): string =>
  `${context.baseUrl}/api/workspaces/${encodeURIComponent(context.workspaceId)}${path}`

export const workspaceRealtimeUrl = (context: ProbeContext): string =>
  `${context.wsBaseUrl}/api/workspaces/${encodeURIComponent(context.workspaceId)}/ws`

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

const authenticate = async (baseUrl: string, token: string): Promise<string> => {
  const authRes = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!authRes.ok) fail(`/api/auth ${authRes.status}`)
  const sessionCookie = authRes.headers
    .getSetCookie()
    .find(c => c.startsWith(SESSION_COOKIE_PREFIX))
    ?.split(';')[0]
  if (!sessionCookie) fail('no session cookie returned by /api/auth')
  return sessionCookie!
}

export const bootstrapProbe = async (opts: BootstrapOptions): Promise<ProbeContext> => {
  const { baseUrl, target, token } = opts
  const wsBaseUrl = baseUrl.replace(/^http/, 'ws')
  const sessionCookie = token ? await authenticate(baseUrl, token) : undefined

  if (target === 'fresh') {
    const workspaceId = crypto.randomUUID()
    for (const moduleId of ['collaboration', 'agents'] as const) {
      const provision = await fetch(`${baseUrl}/internal/${moduleId}/workspaces/${workspaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      if (!provision.ok) fail(`probe ${moduleId} provisioning ${provision.status}`)
    }
    const cookie = sessionCookie ?? ''
    const warm = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/rooms`, { headers: { Cookie: cookie } })
    if (!warm.ok) fail(`probe Workspace warmup ${warm.status}`)
    return { baseUrl, wsBaseUrl, cookie, workspaceId, sessionCookie }
  }

  // Reuse an existing wired Workspace for the non-destructive smoke probe.
  const diagRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
    ...(sessionCookie ? { headers: { Cookie: sessionCookie } } : {}),
  })
  if (!diagRes.ok) fail(`/api/system/diagnostics ${diagRes.status}`)
  const diag = await diagRes.json() as {
    workspaces: Array<{ id: string; wired: boolean }>
  }
  const wired = diag.workspaces.find(workspace => workspace.wired)
  if (!wired) fail('no wired Workspace available')
  const workspaceId = wired!.id
  const cookie = sessionCookie ?? ''
  return { baseUrl, wsBaseUrl, cookie, workspaceId, sessionCookie }
}
