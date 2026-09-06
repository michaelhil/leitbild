import type { ParsedProcedure, ProcedureBranch, ProcedureStep, ProcedureTag, ProcedureTextBlock } from './types.ts'

export const PARSER_PROCMD_VERSION = '0.7'
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Step = Omit<Mutable<ProcedureStep>, 'blocks' | 'branches'> & { blocks: Mutable<ProcedureTextBlock>[]; branches: Mutable<ProcedureBranch>[] }
const keywords = new Set(['check', 'action', 'decision', 'when', 'until', 'abort-if', 'abort-to', 'within', 'concurrent', 'caution', 'note', 'because', 'against'])
const advisory = new Set(['when', 'until', 'abort-if', 'abort-to', 'within', 'concurrent'])
const tagsIn = (text: string): string[] => [...new Set([...text
  .replace(/`+[^`]*`+/g, '').replace(/\[\[[\s\S]*?\]\]/g, '')
  .matchAll(/«([A-Z][A-Z0-9-]*)»/g)].map(match => match[1]!))]

// Deliberately small frontmatter subset: one-line scalars and inline lists.
// Unsupported multiline YAML is diagnosed; original source is never discarded.
const scalar = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { const parsed: unknown = JSON.parse(trimmed); if (typeof parsed === 'string') return parsed } catch { /* unsupported quoting remains literal */ }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  return trimmed
}
const list = (value: string | undefined): string[] => {
  if (!value?.trim()) return []
  const trimmed = value.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1).split(',').map(scalar).filter(Boolean)
    : [scalar(trimmed)]
}

export const parseProcedure = (rawMarkdown: string): ParsedProcedure => {
  const lines = rawMarkdown.split(/\r?\n/)
  const diagnostics: string[] = []
  const warn = (line: number, message: string) => diagnostics.push(`Line ${line}: ${message}`)
  if (lines[0] !== '---') throw new Error('procedure source is missing procmd frontmatter')
  const fmEnd = lines.findIndex((line, index) => index > 0 && line === '---')
  if (fmEnd < 0) throw new Error('procedure source has unterminated procmd frontmatter')
  const fm: Record<string, string> = {}
  for (let index = 1; index < fmEnd; index++) {
    const line = lines[index]!
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!match) { warn(index + 1, 'unsupported frontmatter structure retained in raw source'); continue }
    if (fm[match[1]!] !== undefined) throw new Error(`duplicate frontmatter field ${match[1]}`)
    fm[match[1]!] = match[2]!.trim()
    if (/^[>|]/.test(match[2]!.trim())) warn(index + 1, 'multiline frontmatter semantics unsupported; inspect raw source')
  }
  if (scalar(fm.type ?? '') !== 'procedure') throw new Error('procedure frontmatter requires type: procedure')
  if (scalar(fm['procedure-md'] ?? '') !== PARSER_PROCMD_VERSION) throw new Error(`procedure frontmatter requires procedure-md: ${PARSER_PROCMD_VERSION}`)
  const procedureId = scalar(fm['procedure-id'] ?? '')
  const title = scalar(fm.title ?? '')
  if (!procedureId || !title) throw new Error('procedure frontmatter requires procedure-id and title')
  const knownFm = new Set(['type', 'procedure-md', 'procedure-id', 'title', 'profile', 'category', 'applies-to', 'reference-plant', 'csfs-monitored', 'entry-triggers'])
  const steps: Step[] = []
  const tags: ProcedureTag[] = []
  const preamble: string[] = []
  let current: Step | undefined
  let section: 'preamble' | 'steps' | 'tags' | 'other' = 'preamble'
  let tag: Record<string, string> | undefined
  let activeBranch: Mutable<ProcedureBranch> | undefined
  let decision: Mutable<ProcedureTextBlock> | undefined
  let fence: { marker: string; length: number; block?: Mutable<ProcedureTextBlock> } | undefined

  const flushTag = () => {
    if (!tag) return
    if (tags.some(item => item.id === tag!.id)) throw new Error(`duplicate tag id ${tag.id}`)
    const known = new Set(['id', 'description', 'sim-path', 'units', 'equipment', 'source', 'range'])
    const range = tag.range === undefined ? undefined : list(tag.range).map(Number)
    if (range !== undefined && (range.length !== 2 || !range.every(Number.isFinite))) throw new Error(`invalid range for tag ${tag.id}`)
    tags.push({ id: scalar(tag.id!),
      ...(tag.description === undefined ? {} : { description: scalar(tag.description) }),
      ...(tag['sim-path'] === undefined ? {} : { simPath: scalar(tag['sim-path']) }),
      ...(tag.units === undefined ? {} : { units: scalar(tag.units) }),
      ...(tag.equipment === undefined ? {} : { equipment: scalar(tag.equipment) }),
      ...(tag.source === undefined ? {} : { source: scalar(tag.source) }),
      ...(range === undefined ? {} : { range }),
      annotations: Object.fromEntries(Object.entries(tag).filter(([key]) => !known.has(key))),
    })
    tag = undefined
  }
  const textBlock = (text: string, sourceLine: number, inert = false) => {
    const block: Mutable<ProcedureTextBlock> = { kind: 'text', text, sourceLine, tagIds: inert ? [] : tagsIn(text) }
    if (current) current.blocks.push(block)
    else preamble.push(text)
    return block
  }
  for (let index = fmEnd + 1; index < lines.length; index++) {
    const raw = lines[index]!
    const text = raw.trim()
    const sourceLine = index + 1
    if (fence) {
      if (fence.block) fence.block.text += '\n' + raw
      else preamble.push(raw)
      if (new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`).test(raw)) fence = undefined
      continue
    }
    const openingFence = raw.match(/^\s*(`{3,}|~{3,})/)
    if (openingFence) {
      activeBranch = undefined; decision = undefined
      const block = textBlock(raw, sourceLine, true)
      fence = { marker: openingFence[1]![0]!, length: openingFence[1]!.length, ...(current ? { block } : {}) }
      continue
    }
    const heading = raw.match(/^(#{2,6})\s+Step(?:\s+(.*?))?\s*\[([^\]]+)\]\s*(.*)$/)
    if (heading) {
      flushTag()
      const meta = heading[3]!.split(',').map(value => value.trim())
      const id = meta.find(value => value.startsWith('id:'))?.slice(3).trim()
      if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`Line ${sourceLine}: Step requires an explicit stable id`)
      if (steps.some(step => step.id === id)) throw new Error(`duplicate step id ${id}`)
      if (current) current.sourceEndLine = sourceLine - 1
      const label = heading[2]?.trim() || String(steps.length + 1)
      current = { id, label, title: heading[4]!.replace(/^[-—]\s*/, '').trim() || `Step ${label}`, level: heading[1]!.length,
        blocks: [], branches: [], tagIds: [], sourceLine, sourceEndLine: lines.length }
      steps.push(current)
      section = 'steps'; activeBranch = undefined; decision = undefined
      if (meta.some(value => !value.startsWith('id:'))) warn(sourceLine, 'heading primitive annotations retained in source; override semantics are not implemented')
      if (current.level > 2) warn(sourceLine, 'nested step preserved in source order; inherited lifecycle semantics are not executed')
      continue
    }
    if (/^#{2,6}\s+Step\b/.test(raw)) throw new Error(`Line ${sourceLine}: Step requires [id: stable-id]`)
    if (/^##\s+/.test(raw)) {
      if (current) current.sourceEndLine = sourceLine - 1
      current = undefined; activeBranch = undefined; decision = undefined
      flushTag()
      section = /^##\s+Tags\s*$/i.test(raw) ? 'tags' : 'other'
      if (section === 'other') { preamble.push(raw); warn(sourceLine, 'non-step section retained as document text') }
      continue
    }
    if (section === 'tags') {
      const start = raw.match(/^\s*-\s+id:\s*(.+)$/)
      if (start) { flushTag(); tag = { id: scalar(start[1]!) }; continue }
      const field = raw.match(/^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
      if (tag && field) { tag[field[1]!] = field[2]!.trim(); continue }
      if (text) warn(sourceLine, 'unsupported Tags content retained in raw source')
      continue
    }
    if (!current) { preamble.push(raw); continue }
    if (!text) { activeBranch = undefined; continue }
    if (decision) {
      const path = text.match(/^\d+\.\s+(.+)$/)
      if (path) { decision.paths = [...(decision.paths ?? []), path[1]!]; decision.tagIds = tagsIn([decision.text, ...decision.paths].join('\n')); continue }
      decision = undefined
    }
    const rationale = raw.match(/^\s+(Because|Against):\s*(.+)$/i)
    if (rationale && activeBranch) {
      const key = rationale[1]!.toLowerCase() as 'because' | 'against'
      activeBranch[key] = [activeBranch[key], rationale[2]].filter(Boolean).join('\n')
      activeBranch.tagIds = tagsIn([activeBranch.label, activeBranch.because ?? '', activeBranch.against ?? ''].join('\n'))
      continue
    }
    activeBranch = undefined
    const branch = text.match(/^[-*]\s+(.+?)\s*→\s*(.+)$/)
    if (branch) {
      if ((text.match(/→/g) ?? []).length !== 1) throw new Error(`Line ${sourceLine}: branch requires exactly one arrow`)
      const target = branch[2]!.trim()
      let targetKind: ProcedureBranch['targetKind'] = 'unknown'
      let clean = target
      if (/^#[A-Za-z0-9._:-]+$/.test(target)) { targetKind = 'step'; clean = target.slice(1) }
      else if (/^\[\[[^\]#|]+\]\]$/.test(target)) { targetKind = 'procedure'; clean = target.slice(2, -2) }
      else if (target === 'END') targetKind = 'end'
      else if (target === '↻') targetKind = 'retry'
      else if (target === '↯') targetKind = 'abort'
      if (targetKind === 'unknown') warn(sourceLine, 'unsupported branch target retained as non-actionable text')
      activeBranch = { label: branch[1]!.trim(), target: clean, targetKind, sourceLine, tagIds: tagsIn(branch[1]!) }
      current.branches.push(activeBranch)
      continue
    }
    const keyword = text.match(/^([A-Za-z][A-Za-z-]*):\s*(.*)$/)
    const kind = keyword?.[1]?.toLowerCase()
    if (kind && keywords.has(kind) && keyword![2]!.trim()) {
      const block: Mutable<ProcedureTextBlock> = { kind: kind as ProcedureTextBlock['kind'], text: keyword![2]!.trim(), sourceLine, tagIds: tagsIn(keyword![2]!) }
      current.blocks.push(block)
      if (kind === 'decision') { block.paths = []; decision = block }
      if (advisory.has(kind)) warn(sourceLine, `${kind} is source guidance only; timing/condition/concurrency semantics are not executed`)
      if (kind === 'because' || kind === 'against') warn(sourceLine, 'unattached rationale retained as a block, not assigned to an earlier branch')
      continue
    }
    if (keyword || /^→|^!!!/.test(text)) warn(sourceLine, 'unsupported annotation/transition semantics retained as literal text')
    textBlock(raw, sourceLine)
  }
  flushTag()
  if (fence) warn(lines.length, 'unterminated fenced example retained as literal text')
  if (!steps.length) throw new Error(`no Step headings found in ${procedureId}`)
  for (const step of steps) {
    step.tagIds = [...new Set([...step.blocks.flatMap(block => block.tagIds), ...step.branches.flatMap(branch => branch.tagIds)])]
    for (const branch of step.branches) if (branch.targetKind === 'step' && !steps.some(candidate => candidate.id === branch.target)) warn(branch.sourceLine, `unresolved step target #${branch.target}; no transition inferred`)
  }
  return { procedureId, title, rawMarkdown,
    ...(fm.profile === undefined ? {} : { profile: scalar(fm.profile) }),
    ...(fm.category === undefined ? {} : { category: scalar(fm.category) }),
    ...(fm['applies-to'] === undefined ? {} : { appliesTo: scalar(fm['applies-to']) }),
    ...(fm['reference-plant'] === undefined ? {} : { referencePlant: scalar(fm['reference-plant']) }),
    csfsMonitored: list(fm['csfs-monitored']), entryTriggers: list(fm['entry-triggers']),
    description: preamble.join('\n').trim(), annotations: Object.fromEntries(Object.entries(fm).filter(([key]) => !knownFm.has(key))),
    diagnostics, steps, tags,
  }
}
