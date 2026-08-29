import { nowIso, procedureDocumentSchema, type ProcedureDocument, type ProcedureSource, type ProcedureTag, type ProcedureTagId } from '../model/index.ts'

interface Frontmatter {
  readonly procedureId: string
  readonly title: string
  readonly profile?: string
  readonly category?: string
  readonly appliesTo?: string
  readonly csfsMonitored: ReadonlyArray<string>
  readonly entryTriggers: ReadonlyArray<string>
}

interface MutableStep {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly level: number
  readonly blocks: Array<{
    readonly kind: 'check' | 'action' | 'when' | 'until' | 'abort-if' | 'abort-to' | 'within' | 'concurrent' | 'caution' | 'note' | 'because' | 'text'
    readonly text: string
    readonly tagIds: ReadonlyArray<ProcedureTagId>
  }>
  readonly branches: Array<{
    readonly label: string
    readonly target: string
    readonly targetKind: 'step' | 'procedure' | 'end' | 'retry' | 'abort' | 'unknown'
    because?: string
    readonly tagIds: ReadonlyArray<ProcedureTagId>
  }>
  readonly sourceLine: number
}

const frontmatterFields: Readonly<Record<string, keyof Frontmatter | 'procedureMd' | 'referencePlant' | 'type'>> = {
  'procedure-id': 'procedureId',
  title: 'title',
  profile: 'profile',
  category: 'category',
  'applies-to': 'appliesTo',
  'csfs-monitored': 'csfsMonitored',
  'entry-triggers': 'entryTriggers',
  'procedure-md': 'procedureMd',
  'reference-plant': 'referencePlant',
  type: 'type',
}

const blockKindByPrefix: Readonly<Record<string, MutableStep['blocks'][number]['kind']>> = {
  Check: 'check',
  Action: 'action',
  When: 'when',
  Until: 'until',
  'Abort-if': 'abort-if',
  'Abort-to': 'abort-to',
  Within: 'within',
  Concurrent: 'concurrent',
  Caution: 'caution',
  Note: 'note',
  Because: 'because',
}

const parseArrayValue = (value: string): ReadonlyArray<string> => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return trimmed.length === 0 ? [] : [trimmed]
  return trimmed
    .slice(1, -1)
    .split(',')
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

const parseFrontmatter = (raw: string): { readonly frontmatter: Frontmatter; readonly body: string } => {
  if (!raw.startsWith('---\n')) throw new Error('procedure source is missing procmd frontmatter')
  const end = raw.indexOf('\n---', 4)
  if (end === -1) throw new Error('procedure source has unterminated procmd frontmatter')
  const frontmatterText = raw.slice(4, end)
  const values: Record<string, unknown> = {}
  for (const line of frontmatterText.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const rawKey = match[1] ?? ''
    const key = frontmatterFields[rawKey]
    if (!key) continue
    const rawValue = match[2] ?? ''
    values[key] = rawValue.trim().startsWith('[') ? parseArrayValue(rawValue) : rawValue.trim()
  }
  if (values.type !== 'procedure') throw new Error('procedure frontmatter requires type: procedure')
  if (values.procedureMd !== '0.7') throw new Error('procedure frontmatter requires procedure-md: 0.7')
  if (typeof values.procedureId !== 'string') throw new Error('procedure frontmatter requires procedure-id')
  if (typeof values.title !== 'string') throw new Error('procedure frontmatter requires title')
  return {
    frontmatter: {
      procedureId: values.procedureId,
      title: values.title,
      ...(typeof values.profile === 'string' ? { profile: values.profile } : {}),
      ...(typeof values.category === 'string' ? { category: values.category } : {}),
      ...(typeof values.appliesTo === 'string' ? { appliesTo: values.appliesTo } : {}),
      csfsMonitored: Array.isArray(values.csfsMonitored) ? values.csfsMonitored.filter((item): item is string => typeof item === 'string') : [],
      entryTriggers: Array.isArray(values.entryTriggers) ? values.entryTriggers.filter((item): item is string => typeof item === 'string') : [],
    },
    body: raw.slice(end + '\n---'.length).replace(/^\r?\n/, ''),
  }
}

const tagIdsIn = (text: string): ReadonlyArray<ProcedureTagId> =>
  [...text.matchAll(/«([^»]+)»/g)]
    .map(match => match[1])
    .filter((value): value is string => value !== undefined)
    .map(value => value.trim() as ProcedureTagId)

const targetKindFor = (target: string): MutableStep['branches'][number]['targetKind'] => {
  if (target === 'END') return 'end'
  if (target === '↻') return 'retry'
  if (target === '↯') return 'abort'
  if (target.startsWith('#')) return 'step'
  if (target.startsWith('[[') && target.endsWith(']]')) return 'procedure'
  return 'unknown'
}

const cleanTarget = (target: string): string => {
  if (target.startsWith('[[') && target.endsWith(']]')) return target.slice(2, -2)
  if (target.startsWith('#')) return target.slice(1)
  return target
}

const parseStepHeading = (line: string): { readonly level: number; readonly label: string; readonly id: string; readonly title: string } | null => {
  const match = line.match(/^(#{2,6})\s+Step\s+(.+?)\s+\[id:\s*([a-zA-Z0-9._:-]+)\]\s*(.*)$/)
  if (!match) return null
  const label = match[2]?.trim() ?? ''
  const id = match[3]?.trim() ?? ''
  const title = (match[4]?.trim() || `Step ${label}`).replace(/^[-—]\s*/, '')
  return {
    level: match[1]?.length ?? 2,
    label,
    id,
    title,
  }
}

const parseBlockLine = (line: string): MutableStep['blocks'][number] | null => {
  for (const [prefix, kind] of Object.entries(blockKindByPrefix)) {
    if (!line.startsWith(`${prefix}:`)) continue
    const text = line.slice(prefix.length + 1).trim()
    return { kind, text, tagIds: tagIdsIn(text) }
  }
  return null
}

const parseBranchLine = (line: string): MutableStep['branches'][number] | null => {
  const match = line.match(/^-\s+(.+?)\s+→\s+(.+)$/)
  if (!match) return null
  const label = match[1]?.trim() ?? ''
  const target = match[2]?.trim() ?? ''
  return {
    label,
    target: cleanTarget(target),
    targetKind: targetKindFor(target),
    tagIds: tagIdsIn(label),
  }
}

const parseTags = (lines: ReadonlyArray<string>, startIndex: number): ReadonlyArray<ProcedureTag> => {
  const tags: ProcedureTag[] = []
  let current: Record<string, unknown> | null = null
  const flush = (): void => {
    if (!current || typeof current.id !== 'string') return
    tags.push({
      id: current.id as ProcedureTagId,
      ...(typeof current.description === 'string' ? { description: current.description } : {}),
      ...(typeof current.simPath === 'string' ? { simPath: current.simPath } : {}),
      ...(typeof current.units === 'string' ? { units: current.units } : {}),
      ...(typeof current.equipment === 'string' ? { equipment: current.equipment } : {}),
      ...(typeof current.source === 'string' ? { source: current.source } : {}),
      ...(Array.isArray(current.range) ? { range: current.range as [number, number] } : {}),
    })
  }
  for (const line of lines.slice(startIndex)) {
    const idMatch = line.match(/^\s*-\s+id:\s*(.+)$/)
    if (idMatch) {
      flush()
      current = { id: idMatch[1]?.trim() ?? '' }
      continue
    }
    if (!current) continue
    const fieldMatch = line.match(/^\s+([a-zA-Z0-9_-]+):\s*(.+)$/)
    if (!fieldMatch) continue
    const rawKey = fieldMatch[1] ?? ''
    const value = fieldMatch[2]?.trim() ?? ''
    const key = rawKey === 'sim-path' ? 'simPath' : rawKey
    current[key] = key === 'range'
      ? parseArrayValue(value).map(Number).filter(Number.isFinite)
      : value
  }
  flush()
  return tags
}

const descriptionBeforeSteps = (body: string): string => {
  const stepIndex = body.search(/^##\s+Step\s+/m)
  const candidate = stepIndex === -1 ? body : body.slice(0, stepIndex)
  return candidate
    .split(/\r?\n/)
    .filter(line => !line.startsWith('# '))
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('CSF:'))
    .join('\n')
}

export const parseProcedureMarkdown = (config: {
  readonly source: ProcedureSource
  readonly sourcePath: string
  readonly sourceUrl: string
  readonly rawMarkdown: string
}): ProcedureDocument => {
  const { frontmatter, body } = parseFrontmatter(config.rawMarkdown)
  const lines = body.split(/\r?\n/)
  const steps: MutableStep[] = []
  let current: MutableStep | null = null
  let inTags = false
  let tagStartIndex = -1

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '## Tags') {
      inTags = true
      tagStartIndex = index + 1
      current = null
      continue
    }
    if (inTags) continue
    const heading = parseStepHeading(line)
    if (heading) {
      current = {
        ...heading,
        blocks: [],
        branches: [],
        sourceLine: index + 1,
      }
      steps.push(current)
      continue
    }
    if (!current) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const branch = parseBranchLine(trimmed)
    if (branch) {
      current.branches.push(branch)
      continue
    }
    const because = trimmed.match(/^Because:\s*(.+)$/)
    if (because && current.branches.length > 0) {
      current.branches[current.branches.length - 1] = {
        ...current.branches[current.branches.length - 1]!,
        because: because[1]?.trim() ?? '',
      }
      continue
    }
    const block = parseBlockLine(trimmed)
    if (block) {
      current.blocks.push(block)
      continue
    }
    current.blocks.push({ kind: 'text', text: trimmed, tagIds: tagIdsIn(trimmed) })
  }

  const tags = tagStartIndex === -1 ? [] : parseTags(lines, tagStartIndex)
  const document = {
    source: config.source,
    procedureId: frontmatter.procedureId,
    title: frontmatter.title,
    ...(frontmatter.profile === undefined ? {} : { profile: frontmatter.profile }),
    ...(frontmatter.category === undefined ? {} : { category: frontmatter.category }),
    ...(frontmatter.appliesTo === undefined ? {} : { appliesTo: frontmatter.appliesTo }),
    csfsMonitored: frontmatter.csfsMonitored,
    entryTriggers: frontmatter.entryTriggers,
    description: descriptionBeforeSteps(body),
    sourcePath: config.sourcePath,
    sourceUrl: config.sourceUrl,
    rawMarkdown: config.rawMarkdown,
    steps: steps.map(step => {
      const tagIds = new Set<ProcedureTagId>()
      for (const block of step.blocks) for (const tagId of block.tagIds) tagIds.add(tagId)
      for (const branch of step.branches) for (const tagId of branch.tagIds) tagIds.add(tagId)
      return { ...step, tagIds: [...tagIds] }
    }),
    tags,
  }
  return procedureDocumentSchema.parse(document) as ProcedureDocument
}

export const emptyProcedureSource = (): ProcedureSource => ({
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'leitbild-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  fetchedAt: nowIso(),
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
})
