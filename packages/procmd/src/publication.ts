import { parseProcedure } from './parser.ts'
import { assessmentLeaves } from './assessment.ts'
import type { ProcedureLimits } from './limits.ts'
import type { ParsedProcedure, ProcedureStep } from './types.ts'

export const isProcedureMarkdown = (content: string): boolean => {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return frontmatter !== null && /^type:\s*(?:procedure|"procedure"|'procedure')\s*$/m.test(frontmatter[1]!)
}

const number = '-?\\d+(?:\\.\\d+)?'
const unit = '%|°C|MPa|kg/s|DPM|mSv/h'
const unitNames: Readonly<Record<string, string>> = { '%': 'percent', '°C': 'degC', MPa: 'MPa', 'kg/s': 'kg/s', DPM: 'DPM', 'mSv/h': 'mSv/h' }
const comparators: Readonly<Record<string, string>> = { BELOW: '<', ABOVE: '>', 'AT MOST': '<=', 'AT LEAST': '>=' }
type Claim = { readonly text: string; readonly operators: ReadonlyArray<string>; readonly value: number; readonly unit?: string | undefined }

/** The limits a line's capitalised state words state. */
const claimsIn = (words: string): ReadonlyArray<Claim> => [
  ...[...words.matchAll(new RegExp(`\\b(BELOW|ABOVE|AT MOST|AT LEAST)\\s+(${number})\\s*(${unit})?`, 'gi'))]
    .map(([text, word, value, named]) => ({ text, operators: [comparators[word!.toUpperCase()]!], value: Number(value), unit: named })),
  ...[...words.matchAll(new RegExp(`(?<!steps?\\s)(${number})\\s*(?:${unit})?\\s+TO\\s+(${number})\\s*(${unit})?`, 'gi'))]
    .flatMap(([text, low, high, named]) => [{ text, operators: ['>', '>='], value: Number(low), unit: named }, { text, operators: ['<', '<='], value: Number(high), unit: named }]),
  ...(/\bZERO OR NEGATIVE\b/i.test(words) ? [{ text: 'ZERO OR NEGATIVE', operators: ['<='], value: 0 }] : []),
]

const family = (tagId: string): string => tagId.replace(/(^|-)[A-D](-|$)/, '$1?$2')
const letterOf = (tagId: string): string | undefined => /(?:^|-)([A-D])(?:-|$)/.exec(tagId)?.[1]
/** Trains named in the words: "breakers A and B", "SG A to D". */
const lettersIn = (words: string): ReadonlyArray<string> => [...words.matchAll(/\b(?:SGs?|buses|bus|pumps?|breakers?|trains?|valves?)\s+([A-D](?:\s*(?:,|and|or|to|through)\s*[A-D])*)\b/gi)].flatMap(([, list]) => {
  const letters = list!.match(/[A-D]/g)!
  return /to|through/i.test(list!) ? ['A', 'B', 'C', 'D'].filter(letter => letter >= letters[0]! && letter <= letters.at(-1)!) : letters
})

/** One limit line's words against its limits. A person still reads the table for what words cannot show: a wrong tag with the same unit. */
const lineProblems = (parsed: ParsedProcedure, words: string, limits: ProcedureLimits): ReadonlyArray<string> => {
  const problems: string[] = []
  const claims = claimsIn(words)
  const { any, comparisons } = limits
  if (any !== /\b(ANY|AT LEAST ONE|OR)\b/.test(words.replaceAll('ZERO OR NEGATIVE', ''))) problems.push(any ? '«any» on a line that does not say ANY, AT LEAST ONE or OR' : 'the words say ANY, AT LEAST ONE or OR but the line has no «any»')
  for (const claim of claims) {
    const matched = comparisons.filter(item => claim.operators.includes(item.operator) && item.value === claim.value)
    if (matched.length === 0) problems.push(`the words state ${claim.text}, and no limit does`)
    for (const item of matched) if (claim.unit !== undefined && unitNames[claim.unit] !== item.unit) problems.push(`the words say ${claim.unit}, ${item.tagId} is in ${item.unit}`)
  }
  for (const item of comparisons) {
    const states = parsed.tags.find(tag => tag.id === item.tagId)?.annotations.states?.split('/')
    if (typeof item.value === 'boolean' || (states !== undefined && (item.value === 0 || item.value === 1) && (item.operator === '==' || item.operator === '!='))) {
      const first = (item.value === true || item.value === 1) === (item.operator === '==')
      const word = states?.[first ? 0 : 1]
      if (word === undefined) problems.push(`${item.tagId} ${item.operator} ${item.value} needs states: on its tag`)
      else if (!new RegExp(`\\b${word}\\b`).test(words)) problems.push(`${item.tagId} ${item.operator} ${item.value} means ${word}, which the words do not say`)
    } else if (!claims.some(claim => claim.operators.includes(item.operator) && claim.value === item.value)) problems.push(`limit ${item.tagId} ${item.operator} ${item.value} is not stated in the words`)
  }
  const tags = [...new Set(comparisons.map(item => item.tagId))]
  const limitsOf = (tagId: string) => comparisons.filter(item => item.tagId === tagId).map(item => `${item.operator}${item.value}`).sort().join()
  if (!any) for (const tagId of tags) if (tags.some(other => family(other) === family(tagId) && family(tagId).includes('?') && limitsOf(other) !== limitsOf(tagId))) { problems.push(`${tagId} has different limits from others of its family on this line`); break }
  if (/\b(ALL|NONE|EACH|EVERY)\b/.test(words)) for (const tag of parsed.tags) if (family(tag.id).includes('?') && tags.some(tagId => family(tagId) === family(tag.id)) && !tags.includes(tag.id)) problems.push(`the words say ALL and ${tag.id} is left out`)
  const named = lettersIn(words)
  if (named.length > 0) for (const tagId of tags) { const letter = letterOf(tagId); if (letter !== undefined && !named.includes(letter)) problems.push(`${tagId} is on a line naming ${named.join(', ')}`) }
  for (const letter of named) if (!tags.some(tagId => letterOf(tagId) === letter)) problems.push(`the words name ${letter}, and no limit on this line reads it`)
  return problems
}

const pairOf = (step: ProcedureStep, sourceLine: number) => [...(step.pairs ?? [])].reverse().find(pair => pair.sourceLine < sourceLine)

/** Words against limits. A compiled leaf comes from its line, so a marked document only has to carry no decision block of its own. Empty for a document with no limits that is not marked. */
export const checkProcedureLimits = (parsed: ParsedProcedure): ReadonlyArray<string> => {
  const marked = parsed.annotations['ai-workable'] === 'true'
  const problems: string[] = []
  if (marked && /^\s*(`{3,}|~{3,})procedure-decisions\s*$/m.test(parsed.rawMarkdown)) problems.push(`${parsed.procedureId}: an ai-workable document has no decision block`)
  for (const step of parsed.steps) {
    const at = (line: number, problem: string) => problems.push(`${parsed.procedureId} Step ${step.label}, line ${line}: ${problem}`)
    const lines = step.blocks.filter(block => block.kind === 'check' || block.kind === 'expected' || block.kind === 'when')
    for (const block of lines) {
      const words = block.text.replace(/\s*«[^»]*»/g, '').trim()
      if (block.limits === undefined) {
        // A question, an IF line and a line about whichever SG is affected state a limit no fixed tag can carry.
        if (marked && !/^(?:[a-z]\.\s+)?IF\b|\?|\baffected\b/i.test(words) && claimsIn(words).length > 0) at(block.sourceLine, 'the line states a limit and carries none')
        continue
      }
      for (const problem of lineProblems(parsed, words, block.limits)) at(block.sourceLine, problem)
    }
    const stepWords = step.blocks.filter(block => block.kind !== 'basis').map(block => block.text).join(' ')
    for (const branch of step.branches) for (const item of branch.limits?.comparisons ?? []) {
      if (!lines.some(block => block.tagIds.includes(item.tagId))) at(branch.sourceLine, `${item.tagId} tests this branch and is named on no line of the step`)
      if (typeof item.value === 'number' && !new RegExp(`(^|[^\\d.])${String(item.value).replace('.', '\\.')}($|[^\\d])`).test(stepWords)) at(branch.sourceLine, `${item.tagId} ${item.operator} ${item.value}: that number is on no line of the step`)
    }
  }
  return problems
}

/** What a person reads once at first publish: what the check cannot see, such as a wrong tag with the same unit. */
export const procedureLimitTable = (parsed: ParsedProcedure): string => {
  const rows = parsed.steps.flatMap(step => [
    ...step.blocks.flatMap(block => block.limits === undefined ? [] : block.limits.comparisons.map(item => ({ step, line: block.text.replace(/\s*«[^»]*»/g, ''), group: block.limits!.any ? 'any' : 'all', item, branch: step.branches[pairOf(step, block.sourceLine)?.advisoryBranchIndex ?? -1]?.label ?? '' }))),
    ...step.branches.flatMap(branch => branch.limits === undefined ? [] : branch.limits.comparisons.map(item => ({ step, line: `(fork) ${branch.label}`, group: branch.limits!.any ? 'any' : 'all', item, branch: branch.label }))),
  ])
  return ['| Step | Line | Tag | Tag reads | Limit | Group | Tests branch | Basis |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows.map(({ step, line, group, item, branch }) =>
    `| ${step.label} | ${line} | ${item.tagId} | ${parsed.tags.find(tag => tag.id === item.tagId)?.description ?? ''} | ${item.operator} ${item.value} ${item.unit} | ${group} | ${branch} | ${item.source} |`)].join('\n')
}

/** Document-integrity checks, not engineering or operating qualification.
 * Prefer sibling identities; uniquely identified cross-directory documents can
 * be discovered without defining a second source catalog here.
 */
export const validateProcedurePublication = (documents: ReadonlyArray<{ readonly path: string; readonly content: string }>, validateSource?: (path: string, source: string, requireSection: boolean) => void): void => {
  const procedures = documents.flatMap(document => {
    if (!isProcedureMarkdown(document.content)) return []
    const directory = document.path.slice(0, document.path.lastIndexOf('/') + 1)
    return [{ path: document.path, directory, parsed: parseProcedure(document.content) }]
  })
  const names = new Set<string>()
  for (const document of procedures) {
    const key = `${document.directory}\0${document.parsed.procedureId}`
    if (names.has(key)) throw new Error(`Duplicate procedure identity in ${document.directory}: ${document.parsed.procedureId}`)
    names.add(key)
  }
  for (const { path, directory, parsed } of procedures) {
    const limitProblems = checkProcedureLimits(parsed)
    if (limitProblems.length > 0) throw new Error(`Procedure limits in ${path}:\n${limitProblems.join('\n')}`)
    for (const tagId of parsed.foldout?.tagIds ?? []) if (!parsed.tags.some(tag => tag.id === tagId)) throw new Error(`Undeclared tag ${tagId} in ${path} foldout`)
    for (const tag of parsed.tags) if (tag.source && /\.md(?:#[^\s]+)?$/.test(tag.source)) validateSource?.(path, tag.source, false)
    const declaredTags = new Set(parsed.tags.map(tag => tag.id))
    for (const step of parsed.steps) {
      for (const tagId of step.tagIds) {
        if (!declaredTags.has(tagId)) throw new Error(`Undeclared tag ${tagId} in ${path}#${step.id}`)
      }
      for (const condition of [...(step.assessment ? [step.assessment.condition] : []), ...(step.decisions ?? []).flatMap(decision => decision.condition === undefined ? [] : [decision.condition])]) for (const leaf of assessmentLeaves(condition)) {
        validateSource?.(path, leaf.source, true)
        if (leaf.type === 'comparison' && parsed.tags.find(tag => tag.id === leaf.tagId)?.units !== leaf.unit) {
          throw new Error(`Assessment unit ${leaf.unit} does not match declared tag ${leaf.tagId} units in ${path}#${step.id}`)
        }
      }
      for (const decision of step.decisions ?? []) if (decision.observation) validateSource?.(path, decision.observation.source, true)
      for (const decision of step.decisions ?? []) if (decision.applicability) validateSource?.(path, decision.applicability.source, true)
      for (const branch of step.branches) {
        if (branch.targetKind === 'step' && !parsed.steps.some(candidate => candidate.id === branch.target)) {
          throw new Error(`Missing step target ${branch.target} in ${path}#${step.id}`)
        }
        if (branch.targetKind === 'procedure' && !names.has(`${directory}\0${branch.target}`)) {
          const matches = procedures.filter(candidate => candidate.parsed.procedureId === branch.target)
          if (matches.length !== 1) throw new Error(`Missing or ambiguous procedure target ${branch.target} in ${path}#${step.id}`)
        }
        if (branch.targetKind === 'procedure' && branch.targetStepId !== undefined) {
          const target = procedures.find(candidate => candidate.directory === directory && candidate.parsed.procedureId === branch.target)
            ?? procedures.find(candidate => candidate.parsed.procedureId === branch.target)
          if (!target?.parsed.steps.some(step => step.id === branch.targetStepId)) throw new Error(`Missing procedure step target ${branch.target}#${branch.targetStepId} in ${path}#${step.id}`)
        }
        if (parsed.annotations['procedure-status'] === 'design-guidance' && branch.targetKind === 'unknown') {
          throw new Error(`Design guidance has unsupported branch target in ${path}#${step.id}`)
        }
      }
      if (parsed.annotations['procedure-status'] !== 'design-guidance') continue
      for (const kind of ['basis', 'expected', 'rno', 'unknown'] as const) {
        if (!step.blocks.some(block => block.kind === kind)) throw new Error(`Design guidance requires ${kind} in ${path}#${step.id}`)
      }
      if (!step.branches.some(branch => branch.outcome === 'unknown' && branch.targetKind !== 'unknown')) {
        throw new Error(`Design guidance requires an actionable unknown route in ${path}#${step.id}`)
      }
    }
  }
}
