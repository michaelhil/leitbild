// ============================================================================
// Shared bootstrap for streaming-probe + smoke-streaming.
//
// Both probes need the same first three steps:
//   1. Optionally authenticate (when SAMSINN_TOKEN is set in deploy mode).
//   2. Hit /api/system/diagnostics to verify at least one wired instance.
//   3. Pick a target instance + return the cookie string ready for use.
//
// Centralizing here means both scripts share the SAME instance-selection
// behavior. Rules:
//   * The probe MUST use a fresh instance, NEVER evict or otherwise
//     interfere with a real user's session.
//   * Post f2eda78 (F1–F5 cookieless-instance hardening), pointing a
//     made-up cookie at a made-up id no longer materializes anything —
//     F3 soft-expires unknown ids. The probe follows the browser contract:
//     top-level navigation replaces the stale cookie, then the first API
//     request materializes the server-chosen instance. F5 (cookieless
//     /api/* → 401) is satisfied because every API request carries it.
// ============================================================================

const SESSION_COOKIE_PREFIX = 'samsinn_session='
const INSTANCE_COOKIE_PREFIX = 'samsinn_instance='

export interface ProbeContext {
  readonly baseUrl: string
  readonly wsBaseUrl: string
  readonly cookie: string
  readonly instance: string
  readonly sessionCookie: string | undefined
}

export interface BootstrapOptions {
  readonly baseUrl: string
  // When 'reuse-wired', pick the first wired instance from diagnostics.
  // When 'fresh', generate a new instance id and bind a cookie to it.
  // The post-deploy probe must use 'fresh' to avoid evicting real users.
  readonly target: 'reuse-wired' | 'fresh'
  readonly token?: string
}

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// 16 chars, lowercase alphanumeric — matches the cookie format generated
// server-side by api/instance-cookie.ts. Probe instance ids are visually
// distinct (prefix 'probe') so on-box journals can be greppable.
const generateProbeInstanceId = (): string => {
  const r = Math.random().toString(36).slice(2, 13)
  return `probe${r}`.slice(0, 16).padEnd(16, 'x')
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
    // Send a fresh probe-id cookie through the same top-level navigation
    // flow as a browser. F3 treats the unknown id as stale: API requests
    // return 410, while navigation replaces it with a pending server id.
    // The following /api/rooms call deliberately materializes that id.
    const seedInstance = generateProbeInstanceId()
    const seedCookie = sessionCookie
      ? `${sessionCookie}; ${INSTANCE_COOKIE_PREFIX}${seedInstance}`
      : `${INSTANCE_COOKIE_PREFIX}${seedInstance}`
    const navigation = await fetch(`${baseUrl}/`, { headers: { Cookie: seedCookie } })
    if (!navigation.ok) fail(`probe navigation ${navigation.status}`)
    const issued = navigation.headers
      .getSetCookie()
      .find(c => c.startsWith(`${INSTANCE_COOKIE_PREFIX}`))
      ?.split(';')[0]
    if (!issued) fail('probe navigation did not return a replacement samsinn_instance Set-Cookie')
    const instance = issued!.slice(INSTANCE_COOKIE_PREFIX.length)
    const cookie = sessionCookie ? `${sessionCookie}; ${issued}` : issued!
    const warm = await fetch(`${baseUrl}/api/rooms`, { headers: { Cookie: cookie } })
    if (!warm.ok) fail(`probe instance warmup ${warm.status}`)
    return { baseUrl, wsBaseUrl, cookie, instance, sessionCookie }
  }

  // reuse-wired: legacy behavior used by smoke. Picks an existing wired
  // instance from diagnostics.
  const diagRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
    ...(sessionCookie ? { headers: { Cookie: sessionCookie } } : {}),
  })
  if (!diagRes.ok) fail(`/api/system/diagnostics ${diagRes.status}`)
  const diag = await diagRes.json() as {
    instances: Array<{ id: string; wired: boolean }>
  }
  const wired = diag.instances.find(i => i.wired)
  if (!wired) fail('no wired instance available')
  const instance = wired!.id
  const cookie = sessionCookie
    ? `${sessionCookie}; ${INSTANCE_COOKIE_PREFIX}${instance}`
    : `${INSTANCE_COOKIE_PREFIX}${instance}`
  return { baseUrl, wsBaseUrl, cookie, instance, sessionCookie }
}
