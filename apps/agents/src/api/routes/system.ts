// ============================================================================
// Process information, health, diagnostics, and authentication routes.
// ============================================================================

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { authEnabled, buildSessionCookie, issueSession, validateToken, getAuthLimiter } from '../auth.ts'

// Cached on first read. package.json doesn't change at runtime; the git
// SHA is captured once from the working tree the process was launched
// from. Both stable for the lifetime of the process.
interface SystemInfo {
  readonly version: string
  readonly repoUrl: string
  // Short git SHA of HEAD when the process started. Empty string when
  // not in a git tree (e.g. release tarball, container without .git).
  // Used by ops to verify a deploy actually picked up the latest master
  // — invaluable when prod looks like it should have the fix but the
  // user sees old behaviour. Without this field, the only way to
  // verify the running binary's source is to SSH in.
  readonly gitSha: string
}
let cachedInfo: SystemInfo | null = null

const normalizeRepoUrl = (raw: unknown): string => {
  if (typeof raw === 'string') return raw.replace(/^git\+/, '').replace(/\.git$/, '')
  if (raw && typeof raw === 'object' && 'url' in raw) {
    return normalizeRepoUrl((raw as { url: string }).url)
  }
  return ''
}

// Capture the SHA at startup via a one-shot `git rev-parse --short HEAD`.
// Synchronous Bun spawn keeps boot-time uniform — failure (no git, no .git
// dir) returns ''. Bun.spawnSync is available since Bun 1.0.
const readGitSha = (): string => {
  try {
    const result = Bun.spawnSync({
      cmd: ['git', 'rev-parse', '--short', 'HEAD'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (result.exitCode !== 0) return ''
    return new TextDecoder().decode(result.stdout).trim()
  } catch {
    return ''
  }
}

const readPackageInfo = async (): Promise<SystemInfo> => {
  if (cachedInfo) return cachedInfo
  try {
    const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string; repository?: unknown }
    cachedInfo = {
      version: pkg.version ?? '0.0.0',
      repoUrl: normalizeRepoUrl(pkg.repository),
      gitSha: readGitSha(),
    }
  } catch {
    cachedInfo = { version: '0.0.0', repoUrl: '', gitSha: readGitSha() }
  }
  return cachedInfo
}

export const systemInfoResponse = async (): Promise<Response> =>
  json(await readPackageInfo())

export const authResponse = async (req: Request, remoteAddress?: string): Promise<Response> => {
  if (req.method === 'GET') {
    const enabled = authEnabled()
    if (!enabled) return json({ authEnabled: false, authenticated: true })
    const { sessionFromRequest, isValidSession } = await import('../auth.ts')
    const session = sessionFromRequest(req)
    return json({ authEnabled: true, authenticated: isValidSession(session) })
  }
  if (!authEnabled()) {
    return json({ ok: true })
  }
  const limit = getAuthLimiter().check(remoteAddress)
  if (!limit.ok) {
    const retryS = Math.ceil(limit.retryAfterMs / 1000)
    return new Response(
      JSON.stringify({ error: `too many auth attempts — try again in ${retryS}s` }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryS) } },
    )
  }
  const body = await parseBody(req)
  const candidate = typeof body.token === 'string' ? body.token : ''
  if (!validateToken(candidate)) {
    console.warn(`[auth] failed token attempt from ${remoteAddress ?? 'unknown'}`)
    return errorResponse('invalid token', 401)
  }
  const sessionId = issueSession()
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildSessionCookie(sessionId),
    },
  })
}

export const systemRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/system\/info$/,
    handler: async () => systemInfoResponse(),
  },
  {
    // Auth status — used by the UI to decide whether to show the token prompt.
    // Always succeeds; the body says whether auth is required and whether the
    // current request carries a valid session cookie.
    method: 'GET',
    pattern: /^\/auth$/,
    handler: async (req) => authResponse(req),
  },
  {
    method: 'POST',
    pattern: /^\/auth$/,
    handler: async (req, _match, ctx) => authResponse(req, ctx.remoteAddress),
  },
  {
    // Process-global cap/limit observability snapshot. Read by ops/admin
    // panels. Auth-gated (NOT exempt; only /system/info and /auth
    // bypass the gate). Returns counters + the configured cap values for
    // context.
    method: 'GET',
    pattern: /^\/system\/limits$/,
    handler: async (_req, _match, ctx) => json({
      metrics: ctx.system.limitMetrics.snapshot(),
      configured: {
        maxWsBufferedBytes: 8 * 1024 * 1024,
        maxRateLimitKeys: 4096,
        maxSseBufferBytes: 10 * 1024 * 1024,
        maxScriptSourceBytes: 256 * 1024,
        maxConsecutiveWhisperFailures: 5,
        evictionFlushBackoffMs: [5_000, 15_000, 60_000],
        sessionStaleMs: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  },
  {
    // Per-Workspace broadcast wiring + health snapshot. Operator visibility
    // for the silent-skip class of bug fixed in 5d73a8e: a live Workspace
    // with zero broadcasts under traffic means the wiring chain is broken.
    // Read-only; safe to poll.
    method: 'GET',
    pattern: /^\/system\/diagnostics$/,
    handler: async (_req, _match, ctx) => {
      if (!ctx.diagnostics) return errorResponse('diagnostics not wired', 500)
      return json(ctx.diagnostics.snapshot())
    },
  },
  {
    // Aggregated operator-visibility snapshot. Single URL the operator
    // can poll to see "is anything obviously wrong" without paging
    // through /system/limits + /system/diagnostics + journalctl.
    //
    // Surfaces:
    //   - typecheck / boot status (implicit: if you got this response, boot ok)
    //   - per-provider monitor state (healthy / backoff / unhealthy / oneoff)
    //   - process-wide anomaly counters from limit-metrics
    //   - per-Workspace broadcast wiring + last-broadcast age
    //   - WS session count
    //
    // Counters are PROCESS-WIDE (aggregate across loaded Workspaces),
    // not per-tenant. That's the right shape for operator triage; per-tenant
    // breakdowns belong in /system/diagnostics.
    //
    // Read-only; auth-gated; safe to poll at ~30s cadence.
    method: 'GET',
    pattern: /^\/system\/health$/,
    handler: async (_req, _match, ctx) => {
      const limits = ctx.system.limitMetrics.snapshot()
      const monitors = ctx.system.monitors
      const monitorStates: Record<string, { sub: string; consecutiveFailures: number; lastErrorAt: number | null; modelCount: number }> = {}
      for (const [name, mon] of Object.entries(monitors)) {
        const st = mon.getState()
        monitorStates[name] = {
          sub: st.sub,
          consecutiveFailures: st.consecutiveFailures,
          lastErrorAt: st.lastErrorAt ?? null,
          modelCount: st.modelCount,
        }
      }
      const diag = ctx.diagnostics?.snapshot() ?? { workspaces: [], wsSessions: 0 }
      const now = Date.now()
      const workspaces = diag.workspaces.map(i => ({
        id: i.id,
        wired: i.wired,
        agentCount: i.agentCount,
        generatingAgentCount: i.generatingAgentCount,
        lastBroadcastAt: i.lastBroadcastAt ?? null,
        lastBroadcastAgeMs: i.lastBroadcastAt ? now - i.lastBroadcastAt : null,
      }))
      return json({
        timestamp: now,
        // Anomalies that should be near-zero in normal operation.
        anomalies: {
          wsInvalidJson: limits.wsInvalidJson,
          routerMissingRoom: limits.routerMissingRoom,
          multimodalImagesDropped: limits.multimodalImagesDropped,
          sseBufferExceeded: limits.sseBufferExceeded,
          wsBackpressureDropped: limits.wsBackpressureDropped,
          evictionFlushRetries: limits.evictionFlushRetries,
          evictionForceEvicts: limits.evictionForceEvicts,
          rateLimitEvicted: limits.rateLimitEvicted,
          staleSessionsEvicted: limits.staleSessionsEvicted,
        },
        providers: monitorStates,
        wsSessions: diag.wsSessions,
        workspaces,
      })
    },
  },
]
