import type { ProcedureAssessmentCondition } from './assessment.ts'

export type ProcedureLimitComparison = Extract<ProcedureAssessmentCondition, { type: 'comparison' }>
/** A line's limits, each today's comparison leaf. `any` means at least one; otherwise all. */
export interface ProcedureLimits {
  readonly any: boolean
  readonly comparisons: ReadonlyArray<ProcedureLimitComparison>
}

export interface AuthoredLimits {
  /** The line's words, with the trailing tags removed. */
  readonly body: string
  /** The line as renderers read it: the words, then each named tag once as «TAG». */
  readonly text: string
  readonly any: boolean
  readonly tokens: ReadonlyArray<{ readonly tagId: string; readonly operator: ProcedureLimitComparison['operator']; readonly value: number | boolean }>
}

const limit = /^«([A-Za-z0-9][A-Za-z0-9._/-]*)\s*(==|!=|<=|>=|<|>)\s*(true|false|-?\d+(?:\.\d+)?)»$/
const isLimit = (token: string): boolean => token === '«any»' || /[<>=!]/.test(token)

/** The limits at the end of a line, or undefined where it has none. Nothing is guessed: a misplaced or malformed limit is an error. */
export const readAuthoredLimits = (line: string, sourceLine: number): AuthoredLimits | undefined => {
  const tokens = [...line.matchAll(/«[^»]*»/g)].map(match => match[0])
  if (!tokens.some(isLimit)) return undefined
  const trailing = /(?:\s*«[^»]*»)+\s*$/.exec(line)
  const body = trailing === null ? line : line.slice(0, trailing.index).trimEnd()
  if (trailing === null || [...body.matchAll(/«[^»]*»/g)].some(match => isLimit(match[0]))) throw new Error(`Line ${sourceLine}: limits must end the line`)
  const named: string[] = []
  const parsed: Array<AuthoredLimits['tokens'][number]> = []
  for (const token of [...trailing[0].matchAll(/«[^»]*»/g)].map(match => match[0])) {
    if (token === '«any»') continue
    if (!isLimit(token)) { named.push(token.slice(1, -1)); continue }
    const match = limit.exec(token)
    if (match === null) throw new Error(`Line ${sourceLine}: malformed limit ${token}; write «TAG op value» with op one of < <= > >= == != and a number, true or false`)
    named.push(match[1]!)
    parsed.push({ tagId: match[1]!, operator: match[2]! as ProcedureLimitComparison['operator'], value: match[3] === 'true' ? true : match[3] === 'false' ? false : Number(match[3]) })
  }
  const any = tokens.includes('«any»')
  if (parsed.length === 0 || (any && parsed.length < 2)) throw new Error(`Line ${sourceLine}: «any» needs at least two limits on its line`)
  return { body, text: `${body} ${[...new Set(named)].map(tagId => `«${tagId}»`).join(' ')}`, any, tokens: parsed }
}

export const compileLimits = (authored: AuthoredLimits, config: { readonly sourceLine: number; readonly source: string | undefined; readonly unitOf: (tagId: string) => string | undefined }): ProcedureLimits => {
  if (config.source === undefined) throw new Error(`Line ${config.sourceLine}: a limit needs a Basis link to a document section on its step`)
  return { any: authored.any, comparisons: authored.tokens.map(token => {
    const unit = config.unitOf(token.tagId)
    if (unit === undefined) throw new Error(`Line ${config.sourceLine}: limit tag ${token.tagId} is not declared with units`)
    return { type: 'comparison', tagId: token.tagId, operator: token.operator, value: token.value, unit,
      ...(typeof token.value === 'number' ? { bound: 'value' as const } : {}), evidence: 'engineering-diagnostic', source: config.source!, maxAgeSeconds: limitMaxAgeSeconds }
  }) }
}

export const limitMaxAgeSeconds = 2

/** What a line's limits add to its branch's all-of. */
export const limitConditions = (limits: ProcedureLimits): ReadonlyArray<ProcedureAssessmentCondition> =>
  limits.any ? [{ type: 'any', conditions: limits.comparisons }] : limits.comparisons
