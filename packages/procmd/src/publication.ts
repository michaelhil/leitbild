import { parseProcedure } from './parser.ts'
import { assessmentLeaves } from './assessment.ts'

export const isProcedureMarkdown = (content: string): boolean => {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return frontmatter !== null && /^type:\s*(?:procedure|"procedure"|'procedure')\s*$/m.test(frontmatter[1]!)
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
    for (const tag of parsed.tags) if (tag.source && /\.md(?:#[^\s]+)?$/.test(tag.source)) validateSource?.(path, tag.source, false)
    const declaredTags = new Set(parsed.tags.map(tag => tag.id))
    for (const step of parsed.steps) {
      for (const tagId of step.tagIds) {
        if (!declaredTags.has(tagId)) throw new Error(`Undeclared tag ${tagId} in ${path}#${step.id}`)
      }
      if (step.assessment) for (const leaf of assessmentLeaves(step.assessment.condition)) {
        validateSource?.(path, leaf.source, true)
        if (leaf.type === 'comparison' && parsed.tags.find(tag => tag.id === leaf.tagId)?.units !== leaf.unit) {
          throw new Error(`Assessment unit ${leaf.unit} does not match declared tag ${leaf.tagId} units in ${path}#${step.id}`)
        }
      }
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
