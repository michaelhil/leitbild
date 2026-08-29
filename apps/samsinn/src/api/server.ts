// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import type { WSManager } from './ws-handler.ts'
import { DEFAULTS } from '../core/types/constants.ts'
import { authEnabled, isValidSession, sessionFromRequest, validateToken, issueSession, buildSessionCookie, getAuthLimiter } from './auth.ts'
import { handleAPI, handleUnscopedAPI } from './http-routes.ts'
import { handleWSMessage, type WSData } from './ws-handler.ts'
import {
  WORKSPACE_COOKIE,
  buildWorkspaceCookie, getWorkspaceId, getWorkspaceIdFromPath,
  resolveOrMintWorkspace,
} from './workspace-cookie.ts'
import { resolve, normalize } from 'node:path'
import { getCaptureRegistry } from '../core/biometrics/registry.ts'
import type { WorkspaceDirectory } from '../core/workspaces/directory.ts'
import { createOpenAccessContext } from '../core/workspaces/request-context.ts'
import type { WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { buildSamsinnDiscovery } from './discovery.ts'
import { handleWorkspaceDirectoryApi } from './workspace-api.ts'
import { resolveApplicationApiPath } from './api-path.ts'


// === Server Config ===

interface ServerConfig {
  readonly registry: WorkspaceRuntimeRegistry
  readonly workspaceDirectory: WorkspaceDirectory
  readonly wsManager: WSManager
  readonly port?: number
  readonly bindHost?: string
  readonly uiPath?: string
  // Reset Samsinn state inside the request's Workspace.
  readonly resetWorkspace: (req: Request) => Promise<import('./routes/types.ts').ResetWorkspaceResult>
  // Per-Workspace evict (drop from memory, keep snapshot) — exercises the
  // evict→reload boundary in the deploy gate. Wired by bootstrap.
  readonly evictWorkspace: (req: Request) => Promise<import('./routes/types.ts').EvictWorkspaceResult>
  // Workspace administration wired by bootstrap.
  readonly workspaces: import('./routes/types.ts').WorkspaceAdmin
  // Read-only diagnostics snapshot (per-Workspace broadcast wiring health).
  readonly diagnostics: import('./routes/types.ts').DiagnosticsCapability
  // Leitbild mirror service (process-level). Wired by bootstrap when the
  // integration is initialized. Optional so tests can omit it.
  readonly leitbildMirror?: import('../integrations/leitbild/mirror-service.ts').MirrorService
}

// === Static file serving (path traversal protected) ===

// Served in place of dist.css when the file is missing. A valid stylesheet
// that paints a loud red banner across the top of the page with instructions
// for the developer to recover. Simpler and more visible than a 404 +
// console warning that nobody reads. `bun run start` chains `build:css`
// before boot, so the user should only see this if they bypassed the
// chained script (e.g. running `bun run src/main.ts` directly) or manually
// deleted dist.css while the server is running.
const MISSING_DIST_BANNER = `/* samsinn: dist.css missing — run "bun install && bun run build:css" */
body::before {
  content: "\u26a0 samsinn: CSS build missing. Run: bun install && bun run build:css";
  position: fixed;
  inset: 0 0 auto 0;
  padding: 10px 16px;
  background: #dc2626;
  color: #ffffff;
  font: 600 13px/1.3 system-ui, -apple-system, sans-serif;
  z-index: 2147483647;
  text-align: center;
}
body { padding-top: 40px; }
`

const serveStatic = async (pathname: string, uiPath: string, transpiler: Bun.Transpiler): Promise<Response | null> => {
  if (pathname === '/' || pathname === '/index.html' || getWorkspaceIdFromPath(pathname) !== null) {
    const file = Bun.file(`${uiPath}/index.html`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/html' } })
    }
    return new Response('<h1>samsinn</h1><p>UI coming soon.</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  if ((pathname.startsWith('/modules/') || pathname.startsWith('/lib/')) && pathname.endsWith('.ts')) {
    const filePath = normalize(`${uiPath}${pathname}`)
    if (!filePath.startsWith(uiPath)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(filePath)
    if (await file.exists()) {
      const source = await file.text()
      const js = transpiler.transformSync(source)
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
      })
    }
  }

  // /core/* — UI modules occasionally import shared, browser-safe code from
  // src/core/ (e.g., the canonical render-validator types live in core
  // because the eval loop validates them server-side). The server resolves
  // these to src/core/* and applies the same path-traversal guard. Pure-data
  // modules only — anything pulling in node:* APIs would explode at runtime.
  if (pathname.startsWith('/core/') && pathname.endsWith('.ts')) {
    const corePath = normalize(`${uiPath}/..${pathname}`)
    const coreRoot = normalize(`${uiPath}/../core`)
    if (!corePath.startsWith(coreRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(corePath)
    if (await file.exists()) {
      const source = await file.text()
      const js = transpiler.transformSync(source)
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
      })
    }
  }

  // /biometrics/* — browser-only TypeScript package for webcam-based
  // tracking, lazy-loaded by the biometrics UI extension. Same shape as the
  // /core/ resolver: path-traversal-guarded mapping into src/biometrics/.
  if (pathname.startsWith('/biometrics/') && pathname.endsWith('.ts')) {
    const bioPath = normalize(`${uiPath}/..${pathname}`)
    const bioRoot = normalize(`${uiPath}/../biometrics`)
    if (!bioPath.startsWith(bioRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(bioPath)
    if (await file.exists()) {
      const source = await file.text()
      const js = transpiler.transformSync(source)
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
      })
    }
  }

  if (pathname === '/dist.css') {
    const file = Bun.file(`${uiPath}/dist.css`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' } })
    }
    return new Response(MISSING_DIST_BANNER, {
      status: 200,
      headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' },
    })
  }

  return null
}

// Security headers applied to every HTTP response. CSP intentionally
// absent — that's set by Caddy in deploy/Caddyfile; duplicating it here
// would diverge. These three are cheap defaults that close the worst
// gaps if Bun is ever reached without the reverse proxy in front.
const applySecurityHeaders = (res: Response): Response => {
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  if (!res.headers.has('Referrer-Policy')) {
    res.headers.set('Referrer-Policy', 'same-origin')
  }
  return res
}

const requestBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url)
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || requestUrl.protocol.replace(':', '')
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || request.headers.get('host')
    || requestUrl.host
  return `${protocol}://${host}`
}

// === Server Factory ===

export const createServer = (config: ServerConfig) => {
  const { registry, wsManager } = config
  const port = config.port ?? DEFAULTS.port
  const bindHost = config.bindHost ?? process.env.SAMSINN_BIND_HOST ?? '0.0.0.0'
  const uiPath = resolve(config.uiPath ?? `${import.meta.dir}/../ui`)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const workspaceExists = async (id: WorkspaceId): Promise<boolean> =>
    (await config.workspaceDirectory.get(id)) !== undefined

  // Note: per-Workspace event wiring (broadcasts + autosave) is set up by
  // registry.onWorkspaceRuntimeCreated. createServer no longer wires anything itself.

  // Biometric: when an agent calls biometrics_stop, the capture registry
  // emits a stop request. Broadcast biometric_capture_stop_requested so any
  // live widget for that captureId releases its MediaStream and renders
  // its terminal summary. UI-initiated stops (widget Stop button, unmount,
  // beforeunload) already come FROM the widget — no rebroadcast needed.
  getCaptureRegistry().onAgentStop((captureId) => {
    wsManager.broadcast({ type: 'biometric_capture_stop_requested', captureId, reason: 'agent' })
  })

  const server = Bun.serve<WSData>({
    port,
    hostname: bindHost,

    async fetch(req, server) {
      const url = new URL(req.url)
      const pathname = url.pathname
      // Local alias so the wrap is one short call per return site.
      // WS upgrade returns undefined, so those paths skip wrapping.
      const sec = applySecurityHeaders

      if (pathname === '/.well-known/samsinn' && req.method === 'GET') {
        return sec(Response.json(buildSamsinnDiscovery(requestBaseUrl(req)), {
          headers: { 'Cache-Control': 'public, max-age=60' },
        }))
      }

      // === ?token=<X> redirect — single-click sandbox onboarding ===
      // Lets the operator share `https://host/?token=ABC` with invitees;
      // server validates, issues a session cookie, and 303s to a clean URL.
      // Wrong / unset tokens fall through to the normal flow (UI shows the
      // token prompt) so an outdated link doesn't lock anyone out.
      //
      // A1: rate-limited per IP via the same auth limiter as POST /api/auth
      // so this URL-param path can't bypass the brute-force throttle.
      // Limit hit returns 429 directly (not 303 to clean URL — the user
      // needs to see the rate-limit message).
      if (authEnabled()) {
        const tokenParam = url.searchParams.get('token')
        if (tokenParam) {
          const remoteAddr = server.requestIP(req)?.address
          const limit = getAuthLimiter().check(remoteAddr)
          if (!limit.ok) {
            const retryS = Math.ceil(limit.retryAfterMs / 1000)
            return sec(new Response(`Too many auth attempts — try again in ${retryS}s`, {
              status: 429,
              headers: { 'Retry-After': String(retryS), 'Content-Type': 'text/plain' },
            }))
          }
          if (validateToken(tokenParam)) {
            const sessionId = issueSession()
            const cleaned = new URL(url)
            cleaned.searchParams.delete('token')
            const target = cleaned.pathname + (cleaned.search || '')
            return sec(new Response(null, {
              status: 303,
              headers: {
                'Location': target,
                'Set-Cookie': buildSessionCookie(sessionId),
              },
            }))
          } else {
            console.warn(`[auth] failed ?token= attempt from ${remoteAddr ?? 'unknown'}`)
          }
        }
      }

      // Process-global bootstrap/diagnostic routes must never cross the
      // per-Workspace registry boundary. In particular, deployment probes
      // against /api/system/diagnostics previously created a seeded tenant.
      const unscoped = await handleUnscopedAPI(req, pathname, {
        remoteAddress: server.requestIP(req)?.address,
        diagnostics: config.diagnostics,
      })
      if (unscoped) return sec(unscoped)

      if (pathname === '/api/workspaces' || /^\/api\/workspaces\/[^/]+$/.test(pathname)) {
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return sec(new Response('Unauthorized', { status: 401 }))
        }
        const response = await handleWorkspaceDirectoryApi(
          req,
          url,
          config.workspaceDirectory,
          server.requestIP(req)?.address,
          (workspaceId, modules) => {
            const runtime = registry.tryGetLive(workspaceId)
            if (!runtime) return
            for (const existing of runtime.settings.listModuleBindings()) {
              runtime.settings.removeModuleBinding(existing.moduleId)
            }
            for (const binding of modules) runtime.settings.setModuleBinding(binding)
          },
        )
        if (response) return sec(response)
      }

      // Only explicitly scoped or deployment-level application routes are
      // public. Internal route modules receive the normalized local suffix.
      const applicationApiPath = resolveApplicationApiPath(pathname)
      if (applicationApiPath.kind === 'invalid-api') {
        return sec(Response.json({ error: {
          code: applicationApiPath.code,
          message: applicationApiPath.message,
        } }, { status: applicationApiPath.code === 'invalid_workspace_id' ? 400 : 404 }))
      }

      // Root navigation creates or resumes a Workspace, then moves the browser
      // onto the sole canonical Workspace URL. The UI derives its scope from
      // this path; the HttpOnly cookie binds subsequent requests server-side.
      if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        const selected = getWorkspaceId(req)
        const workspaceId = selected !== null && await workspaceExists(selected)
          ? selected
          : resolveOrMintWorkspace(new Request(req.url, { method: req.method }), url).workspaceId
        if (!(await workspaceExists(workspaceId))) {
          await config.workspaceDirectory.ensure({ id: workspaceId, displayName: 'Samsinn Workspace' })
        }
        return sec(new Response(null, {
          status: 303,
          headers: {
            Location: `/workspaces/${encodeURIComponent(workspaceId)}`,
            'Set-Cookie': buildWorkspaceCookie(workspaceId, req),
          },
        }))
      }

      // A cookie whose Workspace is no longer registered must not silently
      // mint state on background API polling or WebSocket reconnect.
      //
      // Only a top-level navigation renews the cookie. It serves HTML
      // without materializing the Workspace; the subsequent WS open performs
      // the single deliberate load. Other static assets remain readable,
      // while API calls fail closed and WS gets a terminal close code.
      const cookieWorkspaceId = getWorkspaceId(req)
      const pathWorkspaceId = getWorkspaceIdFromPath(pathname)
      const staleCookie = cookieWorkspaceId !== null
        && pathWorkspaceId === null
        && !(await workspaceExists(cookieWorkspaceId))
      if (staleCookie) {
        const staleStatic = await serveStatic(pathname, uiPath, transpiler)
        if (staleStatic !== null) {
          return sec(staleStatic)
        }
        if (pathname === '/favicon.ico') return sec(new Response(null, { status: 204 }))
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return sec(new Response('Unauthorized', { status: 401 }))
        }
        if (/^\/api\/workspaces\/[^/]+\/ws$/.test(pathname)) {
          const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()
          const upgraded = server.upgrade(req, {
            data: {
              sessionToken,
              workspaceId: cookieWorkspaceId!,
              terminalClose: 'workspace-unavailable',
            },
          })
          return upgraded ? undefined : sec(new Response('WebSocket upgrade failed', { status: 500 }))
        }
        return sec(new Response('Workspace unavailable. Reload to create a fresh Workspace.', {
          status: 410,
          headers: { 'Content-Type': 'text/plain' },
        }))
      }

      // === Resolve which Workspace this request is for ===
      // Cookieless requests get a per-visitor id. The cookie is set on the
      // way out; the Workspace itself is materialized lazily by /ws or an
      // /api/* call from the UI — never by a static GET or a cookieless
      // probe (see F1/F5 below).
      const resolvedWorkspace = resolveOrMintWorkspace(req, url)
      const isRealtime = applicationApiPath.kind === 'workspace'
        && applicationApiPath.internalPath === '/ws'
      const workspaceId = isRealtime ? applicationApiPath.workspaceId : resolvedWorkspace.workspaceId
      const setCookieValue = resolvedWorkspace.setCookieValue

      if (pathWorkspaceId !== null && !(await workspaceExists(pathWorkspaceId))) {
        return sec(new Response('Workspace not found', { status: 404 }))
      }

      // F1: static-only paths never need a per-Workspace system. Serve
      // them before getOrLoad so bots/crawlers/uptime probes that just
      // GET / or /dist.css can't materialize an Workspace. The cookie is
      // still attached so the next real call (/ws or /api/*) reuses the
      // same id.
      const earlyStatic = await serveStatic(pathname, uiPath, transpiler)
      if (earlyStatic !== null) {
        // Only a real page navigation starts a visitor session. Direct
        // module/CSS probes remain completely cookieless.
        if (setCookieValue && pathWorkspaceId !== null) {
          const headers = new Headers(earlyStatic.headers)
          headers.append('Set-Cookie', setCookieValue)
          return sec(new Response(earlyStatic.body, { status: earlyStatic.status, headers }))
        }
        return sec(earlyStatic)
      }
      // /favicon.ico has no file but bots GET it constantly. 204 with
      // cookie, no Workspace.
      if (pathname === '/favicon.ico') {
        return sec(new Response(null, { status: 204 }))
      }

      // === WebSocket upgrade ===
      // WS sessions are pure viewers of a Workspace. No agent binding,
      // no reclaim-by-name, no spawn-on-connect. Each post_message names
      // its actor via senderId; non-content commands fall back to 'system'
      // attribution server-side.
      if (isRealtime) {
        // A real UI load receives samsinn_workspace from the initial `/`
        // response before opening its socket. Refuse direct/cookieless WS
        // probes instead of minting and persisting a new seeded Workspace for
        // every reconnecting bot or monitor that does not retain cookies.
        const cookieWorkspace = getWorkspaceId(req)
        if (cookieWorkspace !== null && cookieWorkspace !== workspaceId) {
          return sec(Response.json({ error: { code: 'workspace_scope_mismatch', message: 'Realtime path and Workspace cookie disagree' } }, { status: 409 }))
        }
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return sec(new Response('Unauthorized', { status: 401 }))
        }
        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()
        if (!(await workspaceExists(workspaceId))) {
          return sec(new Response('Workspace not found', { status: 404 }))
        }

        // An intentional Workspace switch keeps the tab's viewer token but
        // changes its cookie. Release the old binding before upgrade instead
        // of rejecting the new socket and leaving the UI blank.
        wsManager.releaseSessionForWorkspaceSwitch(sessionToken, workspaceId)

        const upgraded = server.upgrade(req, { data: { sessionToken, workspaceId } })
        return upgraded ? undefined : sec(new Response('WebSocket upgrade failed', { status: 500 }))
      }

      // Enforce request identity at the public boundary before loading any
      // Workspace runtime. Internal route handlers receive an already-scoped,
      // already-authorized request and contain no transport compatibility logic.
      if (pathname.startsWith('/api/') && getWorkspaceId(req) === null) {
        return sec(new Response('No session', { status: 401 }))
      }
      if (pathname.startsWith('/api/') && authEnabled() && !isValidSession(sessionFromRequest(req))) {
        return sec(new Response('Unauthorized', { status: 401 }))
      }

      // === API + static dispatch ===
      // Resolve the system for this cookie (lazy-loads from disk if evicted).
      if (!(await workspaceExists(workspaceId))) {
        return sec(new Response('Workspace not found', { status: 404 }))
      }
      const accessContext = createOpenAccessContext(workspaceId, req)
      const system = await registry.getOrLoad(workspaceId)
      const remoteAddress = server.requestIP(req)?.address
      let internalApiPath = applicationApiPath.kind === 'deployment'
        ? applicationApiPath.internalPath
        : null
      if (applicationApiPath.kind === 'workspace') {
        if (applicationApiPath.workspaceId !== workspaceId) {
          return sec(Response.json({ error: { code: 'workspace_scope_mismatch', message: 'API path and Workspace session disagree' } }, { status: 409 }))
        }
        internalApiPath = applicationApiPath.internalPath
      }
      if (!internalApiPath) {
        return sec(Response.json({ error: { code: 'route_not_found', message: 'Unknown API route' } }, { status: 404 }))
      }
      const apiResponse = await handleAPI(req, internalApiPath, system, workspaceId, accessContext, {
        broadcast: wsManager.broadcast,
        subscribeAgentState: wsManager.subscribeAgentState,
        unsubscribeAgentState: wsManager.unsubscribeAgentState,
        remoteAddress,
        resetWorkspace: config.resetWorkspace,
        evictWorkspace: config.evictWorkspace,
        broadcastToWorkspace: wsManager.broadcastToWorkspace,
        workspaces: config.workspaces,
        diagnostics: config.diagnostics,
        leitbildMirror: config.leitbildMirror,
      })
      if (apiResponse) {
        // Only append the cookieless-fallback Set-Cookie if the route didn't
        // already set its own samsinn_workspace cookie. Otherwise the browser
        // would honor whichever appears last, masking the route's intent.
        if (setCookieValue) {
          const existing = apiResponse.headers.getSetCookie?.() ?? []
          const alreadySet = existing.some(c => c.startsWith(`${WORKSPACE_COOKIE}=`))
          if (!alreadySet) apiResponse.headers.append('Set-Cookie', setCookieValue)
        }
        return sec(apiResponse)
      }

      // Static was tried before getOrLoad (F1); reaching here means
      // neither a route nor a static file matched.
      return sec(new Response('Not found', { status: 404 }))
    },

    websocket: {
      async open(ws) {
        if (ws.data.terminalClose === 'workspace-unavailable') {
          ws.close(4004, 'Workspace unavailable; reload to create a fresh Workspace')
          return
        }
        // Ensure the Workspace is loaded (lazy materialization on first
        // visit). The session entry is keyed by sessionToken so reconnects
        // and stale-sweep work the same.
        await registry.getOrLoad(ws.data.workspaceId)
        const existing = wsManager.sessions.get(ws.data.sessionToken)
        const session = existing ?? {
          workspaceId: ws.data.workspaceId,
          sessionToken: ws.data.sessionToken,
          lastActivity: Date.now(),
        }
        if (!existing) wsManager.sessions.set(ws.data.sessionToken, session)
        else session.lastActivity = Date.now()
        wsManager.wsConnections.set(ws.data.sessionToken, ws)

        const snap = wsManager.buildSnapshot(ws.data.workspaceId, ws.data.sessionToken)
        if (!snap) { ws.close(4001, 'Workspace unavailable'); return }
        wsManager.safeSend(ws, JSON.stringify(snap))
      },

      async message(ws, raw) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (!session) return
        // A superseded socket may outlive a token rebind briefly. Never let
        // it dispatch against its old System using the new session scope.
        if (session.workspaceId !== ws.data.workspaceId) {
          ws.close(4003, 'Workspace switched')
          return
        }
        session.lastActivity = Date.now()
        // Resolve the cookie's system (lazy-load if evicted between connect
        // and message). Eviction during an active WS is rare — onWorkspaceRuntimeEvicted
        // closes the WS — but races are possible and getOrLoad returns the
        // reloaded system safely.
        const targetSystem = await registry.getOrLoad(ws.data.workspaceId)
        await handleWSMessage(ws, session, typeof raw === 'string' ? raw : raw.toString(), targetSystem, wsManager, config.leitbildMirror)
      },

      close(ws) {
        // v15+ WS sessions own no agent. Just drop the connection map
        // entry; sessions can persist briefly for reconnect (sweep cleans
        // them up after SESSION_STALE_MS).
        if (wsManager.wsConnections.get(ws.data.sessionToken) === ws) {
          wsManager.wsConnections.delete(ws.data.sessionToken)
        }
      },
    },
  })

  console.log(`Server listening on http://${bindHost}:${port}`)
  console.log(`Discovery: http://${bindHost}:${port}/.well-known/samsinn`)
  console.log(`API: http://${bindHost}:${port}/api/workspaces/{workspaceId}`)

  return server
}
