// Rules, settings, estimates and unknowns in words. Each kind has its own shape and word, so they never
// differ by colour alone: ■ Rule, ≈ Estimate, ? Unknown, △ Assumption, § Reference, ◉ From World.
import type { WorldFactCopy } from '../plan/schema.ts'
import { combineWorldFacts } from '../plan/schema.ts'
import { basisWord, durationText, quantityText, sourceMark, type Mark, type TimeFormat } from './format.ts'
import type { Job, Names, Resource, Rule } from './model.ts'
import type { Context } from './status-text.ts'

export const ruleMark: Mark = { shape: '■', word: 'Rule' }
export const estimateMark: Mark = { shape: '≈', word: 'Estimate' }
export const unknownMark: Mark = { shape: '?', word: 'Unknown' }
export const settingMark: Mark = { shape: '□', word: 'Setting' }
/** A soft wanted finish (a goal) as opposed to a hard due time (a rule). */
export const targetMark: Mark = { shape: '◎', word: 'Target' }

/** The hard due time on a job, if a due rule names it. */
export const dueOf = (inputs: Context['inputs'], job: string) => inputs.rules.find((rule): rule is Extract<Rule, { kind: 'due' }> => rule.kind === 'due' && rule.job === job)

export interface RuleView {
  readonly key: string
  readonly mark: Mark
  readonly kind: string
  /** The planner's own words for the rule. */
  readonly words: string
  /** What the rule covers, generated from its fields. */
  readonly covers: string
  readonly source: { readonly mark: Mark; readonly note: string | null }
  /** For a due rule: its latest finish. */
  readonly due: string | null
}


export const ruleView = (rule: Rule, context: Context): RuleView => {
  const { names, format } = context
  const base = { key: rule.key, mark: ruleMark, words: rule.words, source: { mark: sourceMark(rule.source), note: rule.source.note ?? null }, due: rule.kind === 'due' ? rule.finishBy : null }
  switch (rule.kind) {
    case 'protected':
      return { ...base, kind: 'Protected', covers: `Never tagged out, worked or tested: ${names.list(rule.equipment, names.equipment)}.` }
    case 'keep-in-service': {
      const members = rule.members.map(member => 'equipment' in member ? names.equipment(member.equipment) : names.resource(member.resource))
      const during = rule.during === undefined ? 'at all times' : `from ${format.clock(rule.during.start)} to ${format.clock(rule.during.end)}`
      return { ...base, kind: 'Keep in service', covers: `At least ${rule.atLeast} of ${members.length} in service ${during}: ${members.join(', ')}.` }
    }
    case 'due':
      return { ...base, kind: 'Due', covers: `${names.job(rule.job)} must finish by ${format.clock(rule.finishBy)}. No plan may finish it later.` }
    case 'span-limit':
      return {
        ...base, kind: 'Outage limit',
        covers: `${names.group(rule.group)}: out at most ${durationText(rule.limit.value, rule.limit.unit)}, from the first tag-out to the last passed test${rule.singleEntry ? ', as one continuous outage' : ''}.`,
      }
  }
}

export interface SettingView { readonly mark: Mark; readonly name: string; readonly text: string }

/** The window and "one at a time" crews: settings and capacities, shown beside the rules but not as rules. */
export const settingViews = (context: Context): readonly SettingView[] => {
  const { inputs, format } = context
  const window = inputs.settings.window
  const settings: SettingView[] = [{
    mark: settingMark, name: 'Window',
    text: window === null ? 'Not set yet.' : `${format.when(window.start)} to ${format.when(window.end)}${format.zoneSet ? ` (${format.zone})` : ' (UTC: the plan has no site time zone yet)'}.`,
  }]
  for (const resource of inputs.resources.filter(item => item.count === 1)) {
    settings.push({ mark: settingMark, name: resource.label, text: 'One at a time.' })
  }
  return settings
}

export interface ValueView {
  readonly mark: Mark
  readonly text: string
  readonly source: string | null
}

/**
 * A job's duration as an estimate, a World value or an unknown. A World value shows its basis and read
 * time and the warning that it must describe the work.
 */
export const durationView = (job: Job, facts: readonly WorldFactCopy[], format: TimeFormat): ValueView => {
  const { duration } = job
  if (duration.origin.by === 'world') {
    const combined = combineWorldFacts(duration.origin.refs, facts, duration.unit)
    if (!combined.ok) return { mark: unknownMark, text: 'Not read from World yet', source: 'Link the simulation and read the World values.' }
    return {
      mark: sourceMark({ by: 'world' }),
      text: `${durationText(combined.value, duration.unit)} · ${basisWord(combined.basis)} · read ${format.clock(combined.at)}`,
      source: 'Taken from World; check it describes the work.',
    }
  }
  if (duration.value === null) return { mark: unknownMark, text: 'No estimate yet', source: null }
  const range = duration.range === undefined ? '' : ` (${durationText(duration.range.low, duration.unit)} to ${durationText(duration.range.high, duration.unit)})`
  const mark = duration.origin.by === 'assumption' ? sourceMark(duration.origin) : estimateMark
  const calendar = duration.calendar === 'elapsed' ? ' of clock time' : ' of working time'
  return {
    mark,
    text: `${durationText(duration.value, duration.unit)}${calendar}${range}`,
    source: `${sourceMark(duration.origin).word}${duration.origin.note === undefined ? '' : `: ${duration.origin.note}`}`,
  }
}

/** A crew or tool attribute such as payload, with its World basis or the planner's mark. */
export const attributeViews = (resource: Resource, facts: readonly WorldFactCopy[], format: TimeFormat): readonly ValueView[] =>
  resource.attributes.map(attribute => {
    const changes = attribute.changes.map(change => `${quantityText(change.value, attribute.unit)} from ${format.clock(change.at)}`)
    const later = changes.length === 0 ? '' : `; ${changes.join('; ')}`
    if (attribute.origin.by === 'world') {
      const combined = combineWorldFacts(attribute.origin.refs, facts, attribute.unit)
      return combined.ok
        ? { mark: sourceMark({ by: 'world' }), text: `${attribute.label} ${quantityText(combined.value, attribute.unit)} · ${basisWord(combined.basis)} · read ${format.clock(combined.at)}${later}`, source: null }
        : { mark: unknownMark, text: `${attribute.label}: not read from World yet${later}`, source: null }
    }
    if (attribute.value === null) return { mark: unknownMark, text: `${attribute.label}: no value yet${later}`, source: null }
    return { mark: sourceMark(attribute.origin), text: `${attribute.label} ${quantityText(attribute.value, attribute.unit)}${later}`, source: attribute.origin.note ?? null }
  })

/** "Station mechanical crew · 2 crews of 3 · Day shift" */
export const resourceText = (resource: Resource, names: Names): string => {
  const size = resource.kind === 'crew'
    ? `${resource.count} ${resource.count === 1 ? 'crew' : 'crews'}${resource.crewSize === undefined ? '' : ` of ${resource.crewSize}`}`
    : `${resource.count} ${resource.count === 1 ? 'unit' : 'units'}`
  const ahead = resource.maxJobs === undefined ? '' : ` · plans ${resource.maxJobs} ${resource.maxJobs === 1 ? 'job' : 'jobs'} ahead`
  return `${size} · ${names.calendar(resource.calendar)}${ahead}`
}
