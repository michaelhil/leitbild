import type { z } from 'zod'

export const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: Readonly<Record<string, unknown>>
  }
}

/** The most characters an error message carries: what the Host's Module failure envelope admits (contracts moduleFailureSchema). */
export const ERROR_MESSAGE_MAX = 2_048
const ISSUES_SHOWN = 5

/** Text cut at a word boundary within `max` characters, an ellipsis saying so. */
const clipped = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : cut.length)}…`
}

/**
 * A refusal's issues as one short reason a caller can act on: the first five by path and message, then "+N more
 * issues"; within ERROR_MESSAGE_MAX by construction (five lines of at most 342 characters and the count).
 */
export const issuesReason = (issues: ReadonlyArray<{ readonly path: string; readonly message: string }>): string => [
  ...issues.slice(0, ISSUES_SHOWN).map(issue => `${clipped(issue.path === '' ? 'input' : issue.path, 120)}: ${clipped(issue.message, 220)}`),
  ...(issues.length > ISSUES_SHOWN ? [`+${issues.length - ISSUES_SHOWN} more issues`] : []),
].join('; ')

type ZodIssue = z.ZodError['issues'][number]
const depth = (issues: ReadonlyArray<ZodIssue>): number => Math.max(0, ...issues.map(issue => issue.path.length))
/**
 * A union's issues as the option the input came nearest to, by their full paths: the one with the fewest issues, then
 * the one the input matched deepest (an object given where a name or an object is taken is judged as the object).
 */
const leafIssues = (issues: ReadonlyArray<ZodIssue>, base: ReadonlyArray<PropertyKey> = []): ReadonlyArray<{ readonly path: string; readonly message: string }> =>
  issues.flatMap(issue => {
    const path = [...base, ...issue.path]
    if (issue.code !== 'invalid_union' || issue.errors.length === 0) return [{ path: path.map(String).join('.'), message: issue.message }]
    return leafIssues([...issue.errors].sort((left, right) => left.length - right.length || depth(right) - depth(left))[0]!, path)
  })

/** A validation failure as its short reason ("pin.0.spec.question: Invalid input: expected string, received undefined"). */
export const zodReason = (error: z.ZodError): string => issuesReason(leafIssues(error.issues))

/** Every World error, within what the Host's envelope admits: a longer message is cut at a word, marked "…". */
export const apiError = (status: number, code: string, message: string, details?: Readonly<Record<string, unknown>>): Response =>
  json({ error: { code, message: clipped(message, ERROR_MESSAGE_MAX), ...(details === undefined ? {} : { details }) } } satisfies ApiErrorBody, { status })

export const readJson = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (text.trim().length === 0) return {}
  return JSON.parse(text) as unknown
}
