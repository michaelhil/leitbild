// ============================================================================
// Shared bootstrap for streaming-probe + smoke-streaming.
//
// Both probes need the same first three steps:
//   1. Optionally authenticate (when SAMSINN_TOKEN is set in deploy mode).
//   2. Hit /api/system/diagnostics to verify at least one wired Workspace.
//   3. Pick a target Workspace + return the cookie string ready for use.
//
// Centralizing here means both scripts share the SAME Workspace-selection
// behavior. Rules:
//   * The probe MUST use a fresh Workspace, NEVER evict or otherwise
//     interfere with a real user's session.
//   * The probe follows the browser contract: top-level navigation creates
//     a Workspace record and issues its cookie, then the first API request
//     materializes Samsinn state. F5 (cookieless
//     /api/* → 401) is satisfied because every API request carries it.
// ============================================================================

const SESSION_COOKIE_PREFIX = 'samsinn_session='
const WORKSPACE_COOKIE_PREFIX = 'samsinn_workspace='

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
    const navigation = await fetch(`${baseUrl}/`, {
      ...(sessionCookie ? { headers: { Cookie: sessionCookie } } : {}),
    })
    if (!navigation.ok) fail(`probe navigation ${navigation.status}`)
    const issued = navigation.headers
      .getSetCookie()
      .find(c => c.startsWith(WORKSPACE_COOKIE_PREFIX))
      ?.split(';')[0]
    if (!issued) fail('probe navigation did not return a samsinn_workspace Set-Cookie')
    const workspaceId = issued!.slice(WORKSPACE_COOKIE_PREFIX.length)
    const cookie = sessionCookie ? `${sessionCookie}; ${issued}` : issued!
    const warm = await fetch(`${baseUrl}/api/rooms`, { headers: { Cookie: cookie } })
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
  const cookie = sessionCookie
    ? `${sessionCookie}; ${WORKSPACE_COOKIE_PREFIX}${workspaceId}`
    : `${WORKSPACE_COOKIE_PREFIX}${workspaceId}`
  return { baseUrl, wsBaseUrl, cookie, workspaceId, sessionCookie }
}
