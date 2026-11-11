// "This plan at a glance" for the first screen: the window, each group's outage limit and guideline,
// what is protected and its World state at read time, the preconditions, order deadlines, crews and
// their hours, and the promises the plan depends on. Generated from the plan; nothing is stored.
import { durationText, factText, sourceMark, type Mark } from './format.ts'
import { orderView, resourceHoursText } from './rules-text.ts'
import type { Context } from './status-text.ts'

export interface GlanceLine { readonly mark: Mark | null; readonly text: string; readonly world: readonly string[] }
export interface Glance { readonly title: string; readonly lines: readonly GlanceLine[] }

const ruleMark: Mark = { shape: '■', word: 'Rule' }

export const glance = (context: Context): readonly Glance[] => {
  const { inputs, names, format } = context
  const factsOf = (locator: string | undefined, limit: number): readonly string[] => locator === undefined
    ? []
    : inputs.world.facts.filter(fact => fact.locator === locator).slice(0, limit).map(fact => factText(fact, format))
  const sections: Glance[] = []

  const window = inputs.settings.window
  sections.push({
    title: 'Window',
    lines: [{ mark: null, world: [], text: window === null ? 'No window yet.' : `${format.when(window.start)} to ${format.when(window.end)}${inputs.settings.dataDate === null ? '' : `; now ${format.clock(inputs.settings.dataDate)}`}.` }],
  })

  const groups = inputs.groups.map((group): GlanceLine => {
    const limit = inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === group.key)
    const guideline = inputs.goals.find(goal => goal.metric === 'span-over' && goal.threshold !== undefined && (goal.scope?.groups === undefined || goal.scope.groups.includes(group.key)))?.threshold
    const parts = [
      limit?.kind === 'span-limit' ? `out at most ${durationText(limit.limit.value, limit.limit.unit)}, first tag-out to last passed test` : 'no outage limit',
      ...guideline === undefined ? [] : [`guideline ${durationText(guideline.value, guideline.unit)}`],
    ]
    return { mark: limit === undefined ? null : ruleMark, world: [], text: `${group.label}: ${parts.join('; ')}.` }
  })
  if (groups.length > 0) sections.push({ title: 'Function groups', lines: groups })

  const protectedLines = inputs.rules.flatMap(rule => rule.kind !== 'protected' ? [] : rule.equipment.map((key): GlanceLine => {
    const item = inputs.equipment.find(entry => entry.key === key)
    const world = factsOf(item?.locator, 2)
    return { mark: ruleMark, text: `${names.equipment(key)} is never touched.`, world: item?.locator !== undefined && world.length === 0 ? ['Not read from World yet'] : world }
  }))
  const keepLines = inputs.rules.flatMap((rule): GlanceLine[] => rule.kind !== 'keep-in-service' ? [] : [{
    mark: ruleMark, world: [],
    text: `At least ${rule.atLeast} of ${rule.members.map(member => 'equipment' in member ? names.equipment(member.equipment) : names.resource(member.resource)).join(', ')} in service.`,
  }])
  if (protectedLines.length + keepLines.length > 0) sections.push({ title: 'Must stay in service', lines: [...protectedLines, ...keepLines] })

  const dues = inputs.rules.flatMap((rule): GlanceLine[] => rule.kind !== 'due' ? [] : [{
    mark: ruleMark, world: [], text: `${names.job(rule.job)} is due ${format.clock(rule.finishBy)}: ${rule.words}`,
  }])
  const targets = inputs.jobs.flatMap((job): GlanceLine[] => job.target === undefined ? [] : [{
    mark: { shape: '◎', word: 'Target' }, world: [], text: `${job.title}: wanted by ${format.clock(job.target.finishBy)}, may slip (a goal).`,
  }])
  if (dues.length + targets.length > 0) sections.push({ title: 'Finish by', lines: [...dues, ...targets] })

  const checks = inputs.jobs.flatMap(job => job.checks.map((check): GlanceLine => {
    const item = inputs.equipment.find(entry => entry.key === check.equipment)
    const fact = item?.locator === undefined ? undefined : inputs.world.facts.find(entry => entry.locator === item.locator && entry.id === check.fact)
    return {
      mark: { shape: '?', word: 'Precondition' }, text: `${job.title} is ready only if: ${check.words}.`,
      world: fact === undefined ? ['Not read from World yet'] : [`${fact.value === check.expect ? 'Met' : 'Not met'} at read time: ${factText(fact, format)}`],
    }
  }))
  if (checks.length > 0) sections.push({ title: 'Ready only if', lines: checks })

  const crews = inputs.resources.map((resource): GlanceLine => ({
    mark: sourceMark(resource.source).shape === '●' ? null : sourceMark(resource.source),
    world: factsOf(resource.locator, 2),
    text: `${resource.label}: ${resource.count === 1 ? '' : `${resource.count}, `}${names.calendar(resource.calendar)} (${resourceHoursText(resource, inputs, format)})${resource.words === undefined ? '' : `. ${resource.words}`}`,
  }))
  if (crews.length > 0) sections.push({ title: 'Crews and tools', lines: crews })

  const orders = inputs.purchases.flatMap((purchase): GlanceLine[] => {
    const order = orderView(purchase, inputs, format)
    return order === null ? [] : [{ mark: order.mark, world: [], text: order.text }]
  })
  const bookings = inputs.purchases.flatMap((purchase): GlanceLine[] => purchase.replaces.length === 0 ? [] : [{
    mark: null, world: [],
    text: `${names.resource(purchase.resource)} is booked ${purchase.replaces.map(period => format.range(period.start, period.end)).join(', ')}; “${purchase.label}” moves it.`,
  }])
  if (orders.length + bookings.length > 0) sections.push({ title: 'Orders and bookings', lines: [...orders, ...bookings] })

  const promises = inputs.jobs.flatMap((job): GlanceLine[] => job.notBefore?.source.by !== 'assumption' ? [] : [{
    mark: sourceMark(job.notBefore.source), world: [],
    text: `${job.title}: depends on a promise, ${format.clock(job.notBefore.at)}. ${job.notBefore.words}`,
  }])
  if (promises.length > 0) sections.push({ title: 'Promises', lines: promises })

  return sections
}

