// ============================================================================
// Bug reporting — POST /bugs creates a GitHub issue on the configured
// repo using a server-side PAT. The browser never sees the token.
//
// Config via env (set in /etc/leitbild/agents.env on production):
//   LEITBILD_GH_TOKEN  — fine-grained PAT with Issues: Read+Write on the repo
//   LEITBILD_GH_REPO   — "owner/repo" (defaults to michaelhil/leitbild)
//
// If LEITBILD_GH_TOKEN is unset the route returns 503 — the UI surfaces it
// as "bug reporting not configured on this server."
//
// Rate-limited via a dedicated per-IP limiter (10/hour by default) — see
// getBugLimiter below. Not shared with Workspace creation: bug submissions
// are rarer for legitimate users and the abuse path (spam to the
// operator's public GitHub repo) needs a tighter cap than Workspace
// creation does.
//
// Auto-context attached to every issue: app version + browser UA, sourced
// from the request body (the UI fills these from /system/info +
// navigator.userAgent). Never includes room names, agent names, messages,
// or logs — those would leak user content to a public repo.
// ============================================================================

import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { createRateLimiter, type RateLimiter } from '../rate-limit.ts'

const REPO = process.env.LEITBILD_GH_REPO ?? 'michaelhil/leitbild'
const TOKEN = process.env.LEITBILD_GH_TOKEN ?? ''

// A3: dedicated rate limiter, NOT shared with Workspace creation. Tighter
// window — bug submissions are rare for legitimate users (10/hour is
// generous; a frustrated user retrying still goes through), and the
// abuse path (an authenticated tester spamming the operator's GitHub
// repo) is meaningfully expensive to defend against later. Override
// via LEITBILD_BUG_RATE_LIMIT and LEITBILD_BUG_RATE_WINDOW_MS.
let bugLimiter: RateLimiter | null = null
const getBugLimiter = (): RateLimiter => {
  if (!bugLimiter) {
    bugLimiter = createRateLimiter({
      windowMs: Number(process.env.LEITBILD_BUG_RATE_WINDOW_MS) || 3_600_000, // 1 hour
      max: Number(process.env.LEITBILD_BUG_RATE_LIMIT) || 10,
    })
  }
  return bugLimiter
}

// Boot log — once at module load, never logs the token itself.
if (TOKEN) {
  console.log(`[bugs] reporting enabled (repo=${REPO})`)
} else {
  console.log('[bugs] reporting disabled (set LEITBILD_GH_TOKEN to enable)')
}

const MAX_TITLE = 200
const MAX_DESC = 8000

// A5: wrap user description in a 4-tilde fenced code block so GitHub
// doesn't render any markdown features inside it. Eliminates @user
// mentions (which would ping unrelated GitHub users from the operator's
// repo), #123 issue cross-references, image hotlinks, and any future
// GitHub markdown features. Cost: the description renders as plain text
// — fine for bug reports, where the operator reads it as content not
// markup.
//
// 4-tilde fence is used so a description containing the more common
// ``` triple-backticks doesn't close the wrapper early. To defend
// against deliberate fence-escape via embedded ~~~~+ in input, replace
// any 4+ tildes in the user content with 3 tildes before wrapping.
const wrapAsCodeBlock = (s: string): string => {
  const safe = s.replace(/~~~~+/g, '~~~')
  return `~~~~\n${safe}\n~~~~`
}

// Exported for test seam — buildIssueBody returns the GitHub markdown body
// string that gets POSTed; unit tests assert the wrap + escape behaviour.
export const buildIssueBody = (
  description: string,
  version: string,
  userAgent: string,
): string => {
  const ua = userAgent.length > 500 ? userAgent.slice(0, 500) + '…' : userAgent
  return [
    '*Reported via leitbild UI*',
    '',
    wrapAsCodeBlock(description.trim()),
    '',
    '---',
    `leitbild version: \`${version || 'unknown'}\``,
    `user agent: \`${ua || 'unknown'}\``,
  ].join('\n')
}

export const createFeedbackSubmitter =
  (config: {
    token: string
    repo: string
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  }) =>
  async (req: Request, remoteAddress?: string): Promise<Response> => {
    const TOKEN = config.token,
      REPO = config.repo
    if (!TOKEN) return errorResponse('bug reporting not configured', 503)

    const limit = getBugLimiter().check(remoteAddress)
    if (!limit.ok) {
      const retryS = Math.ceil(limit.retryAfterMs / 1000)
      return new Response(
        JSON.stringify({ error: `rate limit — try again in ${retryS}s` }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryS),
          },
        },
      )
    }

    if (!req.headers.get('content-type')?.startsWith('application/json'))
      return errorResponse('Expected JSON feedback', 415)
    const reader = req.body?.getReader()
    if (!reader) return errorResponse('Feedback is required', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      // Bound actual incoming bytes, including Unicode and JSON overhead.
      if (size > 65_536) {
        await reader.cancel()
        return errorResponse('Feedback is too large', 413)
      }
      chunks.push(chunk.value)
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(await new Blob(chunks).text())
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return errorResponse('Invalid feedback', 400)
    } catch {
      return errorResponse('Invalid feedback JSON', 400)
    }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const description =
      typeof body.description === 'string' ? body.description.trim() : ''
    if (!title) return errorResponse('title is required', 400)
    if (title.length > MAX_TITLE)
      return errorResponse(`title too long (max ${MAX_TITLE})`, 400)
    if (!description) return errorResponse('description is required', 400)
    if (description.length > MAX_DESC)
      return errorResponse(`description too long (max ${MAX_DESC})`, 400)

    const version = typeof body.version === 'string' ? body.version : ''
    const userAgent = typeof body.userAgent === 'string' ? body.userAgent : ''

    const issueBody = buildIssueBody(description, version, userAgent)
    // A4: 15s abort. A slow / hung GitHub response otherwise leaves the
    // connection open indefinitely — bad for UX (UI spinner) and for the
    // server's outbound socket pool. AbortError lands in the catch below
    // alongside DNS / connection-refused / etc., which already maps to
    // the "network failure" UI path. No separate branch needed.
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15_000)
    let res: Response
    let responseText = ''
    try {
      res = await (config.fetchImpl ?? fetch)(
        `https://api.github.com/repos/${REPO}/issues`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'leitbild-bug-reporter',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body: issueBody }),
          signal: controller.signal,
        },
      )
      responseText = await res.text()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[bugs] network error: ${reason}`)
      return errorResponse('bug submission failed (network)', 502)
    } finally {
      clearTimeout(timeoutId)
    }

    if (res.status === 201) {
      let issue: { html_url?: unknown; number?: unknown; id?: unknown } | null =
        null
      try {
        issue = JSON.parse(responseText)
      } catch {
        /* An invalid receipt is not confirmation. */
      }
      if (
        !issue ||
        !Number.isSafeInteger(issue.id) ||
        !Number.isSafeInteger(issue.number) ||
        Number(issue.number) < 1 ||
        issue.html_url !== `https://github.com/${REPO}/issues/${issue.number}`
      ) {
        return errorResponse(
          'Submission could not be confirmed. Your feedback may have arrived; please avoid immediately resubmitting.',
          502,
        )
      }
      return json(
        { ok: true, htmlUrl: issue.html_url, number: issue.number },
        201,
      )
    }

    // Discriminate failure modes so the UI can show actionable messages.
    if (res.status === 401) {
      console.error('[bugs] GitHub auth failed (check LEITBILD_GH_TOKEN)')
      return errorResponse('bug reporting auth failed — contact admin', 502)
    }
    if (res.status === 403) {
      const retryAfter = res.headers.get('retry-after')
      const r = retryAfter
        ? new Response(
            JSON.stringify({ error: 'GitHub rate-limited — try again later' }),
            {
              status: 503,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': retryAfter,
              },
            },
          )
        : errorResponse('GitHub rate-limited — try again later', 503)
      return r
    }
    if (res.status === 422) {
      return errorResponse('Feedback was rejected by the issue tracker', 400)
    }
    console.error(`[bugs] GitHub status ${res.status}`)
    return errorResponse(`bug submission failed (${res.status})`, 502)
  }

export const submitFeedback = createFeedbackSubmitter({
  token: TOKEN,
  repo: REPO,
})

export const bugRoutes: RouteEntry[] = [
  {
    method: 'POST',
    pattern: /^\/bugs$/,
    handler: (req, _match, ctx) => submitFeedback(req, ctx.remoteAddress),
  },
]
