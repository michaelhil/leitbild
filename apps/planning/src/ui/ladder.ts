// "What overtime buys" (design §4.1): one ladder per method, the rungs of bought crew time and the rows
// between two rungs, as planning.plan.read section buys gives them. Each row's word is the Module's own, shown
// exactly, with the higher rung's cause of the finish where it names one; the differences are the Module's, in
// hours and money; what each rung uses is the checker's own measure. A rung is named by what it buys, from the
// plan's purchases, and solved by lane S's per-method request. Nothing here compares or ranks options.
import type { z } from 'zod'
import type { buysRowSchema, buysRungSchema, sectionDataSchemas } from '../api/contract.ts'
import type { PlanInputs } from '../plan/schema.ts'
import { isTimeUnit, timeUnitMs } from '../time/units.ts'
import { causeParts, type Part } from './explain-text.ts'
import { hoursNumber, hoursText, moneyText, quantityText, type Mark, type TimeFormat } from './format.ts'
import { joinWords, type OptionView, type PlanModel } from './model.ts'
import { outageOf, planLimitOf } from './options-glance.ts'
import { shortCause } from './outcome.ts'
import { crewHourPurchases } from './request.ts'
import { goalShort, statusView, type Context } from './status-text.ts'

export type BuysPage = z.infer<typeof sectionDataSchemas.buys>
export type BuysRung = z.infer<typeof buysRungSchema>
export type BuysRow = z.infer<typeof buysRowSchema>

/** What one stretch of bought time is, from its periods in the plan zone: a night, a day, or a period. */
const periodWord = (inputs: PlanInputs, key: string, format: TimeFormat): { readonly one: string; readonly many: string } => {
  const purchase = inputs.purchases.find(item => item.key === key)
  const periods = purchase !== undefined && 'periods' in purchase.adds ? purchase.adds.periods : []
  const overnight = (period: { start: string; end: string }) => format.day(period.start) !== format.day(Date.parse(period.end) - 1)
  if (periods.length > 0 && periods.every(overnight)) return { one: 'night', many: 'nights' }
  if (periods.length > 0 && periods.every(period => !overnight(period))) return { one: 'day', many: 'days' }
  return { one: 'period', many: 'periods' }
}

/** The purchase a checker measure `bought:<purchase>` names, or null. */
const boughtKey = (metric: BuysRung['bought'][number]): string | null => metric.id.startsWith('bought:') ? metric.id.slice('bought:'.length) : null

/**
 * What a rung uses of one purchase, from the checker's `bought:<purchase>` measure (one per purchase the
 * schedule uses): person-hours ("person-h") for time priced per person-hour, else the periods used, each
 * named a night or a day from the purchase's own periods. A measure for a purchase not in the plan is left out.
 */
const useText = (metric: BuysRung['bought'][number], context: Context): string | null => {
  const key = boughtKey(metric)
  const purchase = key === null ? undefined : context.inputs.purchases.find(item => item.key === key)
  if (purchase === undefined) return null
  if (metric.unit === 'person-h') return `${purchase.label}: ${hoursNumber(metric.value)} person-hours`
  if (isTimeUnit(metric.unit)) return `${purchase.label}: ${hoursNumber(metric.value * timeUnitMs[metric.unit] / timeUnitMs.h)} person-hours`
  if (metric.unit !== 'periods') return `${purchase.label}: ${quantityText(metric.value, metric.unit)}`
  const word = periodWord(context.inputs, purchase.key, context.format)
  return `${purchase.label}: ${hoursNumber(metric.value)} ${metric.value === 1 ? word.one : word.many}`
}

/** The crew-time purchases a buy list holds: those "days only" excludes. */
const crewTimeIn = (buy: readonly string[], inputs: PlanInputs): readonly string[] => {
  const crewTime = new Set(crewHourPurchases(inputs).map(purchase => purchase.key))
  return buy.filter(key => crewTime.has(key))
}

/**
 * A rung's name, by what it buys: the lowest rung is "Days only" (with any crew time already ordered, which
 * every rung holds); each higher rung names the crew time it adds to the one below.
 */
export const rungName = (rung: BuysRung, below: BuysRung | undefined, context: Context): string => {
  const own = crewTimeIn(rung.buy, context.inputs)
  if (below === undefined) {
    return own.length === 0 ? 'Days only' : `Days only, with ${context.names.list(own, context.names.purchase)} already ordered`
  }
  const lower = new Set(crewTimeIn(below.buy, context.inputs))
  const added = own.filter(key => !lower.has(key))
  return added.length === 0 ? `The same crew time as rung ${below.rung + 1}` : `+ ${joinWords(added.map(context.names.purchase))}`
}

const outcomeOf = (option: OptionView, model: PlanModel, context: Context): string => {
  if (option.status.word === 'proven infeasible') return `Not possible: ${shortCause(option, model, context)}`
  const view = statusView(option.status, context)
  if (option.status.word !== 'validated feasible') return view.sentence
  const outage = outageOf(option, context.inputs)
  const limit = outage === null ? null : planLimitOf(outage.group, context.inputs)
  const cost = context.inputs.goals.findIndex(goal => goal.metric === 'extra-cost')
  const costLine = cost < 0 ? undefined : option.status.goals.find(line => line.goal === cost)
  return [
    outage === null ? null : `Longest outage ${quantityText(outage.value, outage.unit)}${limit === null ? '' : ` of ${limit}`}`,
    costLine === undefined ? null : `${goalShort(context.inputs.goals[cost]!, context)} ${moneyText(costLine.value, costLine.unit)}`,
  ].filter(part => part !== null).join(' · ')
}

/**
 * A row's differences in words, naming their subject, so a goal's "proven optimal" beside a row's "found" does
 * not read as a contradiction: the higher rung's longest outage against the lower's, in hours, and its extra
 * cost, in the plan's currency.
 */
export const differenceText = (row: Pick<BuysRow, 'outage' | 'cost'>, currency: string): string | null => {
  if (row.outage === undefined || row.cost === undefined) return null
  const outage = row.outage < 0 ? `longest outage ${hoursText(-row.outage)} shorter` : row.outage > 0 ? `longest outage ${hoursText(row.outage)} longer` : 'the same longest outage'
  const cost = row.cost > 0 ? `extra cost ${moneyText(row.cost, currency)} more` : row.cost < 0 ? `extra cost ${moneyText(-row.cost, currency)} less` : 'the same extra cost'
  return `${outage} · ${cost}`
}

/**
 * What a solved rung's schedule buys, one line per purchase it uses; a rung that may buy crew time and uses
 * none says so, since the checker gives a figure only for a purchase the schedule uses.
 */
const usesOf = (rung: BuysRung, context: Context): readonly string[] => {
  const lines = rung.bought.flatMap(metric => { const text = useText(metric, context); return text === null ? [] : [text] })
  const used = new Set(rung.bought.flatMap(metric => boughtKey(metric) ?? []))
  const crewTime = crewTimeIn(rung.buy, context.inputs)
  return crewTime.length > 0 && !crewTime.some(key => used.has(key)) ? [...lines, 'Uses none of the crew time it may buy.'] : lines
}

type MethodPick = { readonly choice: string; readonly option: string }
/** Every combination of the plan's method options, in plan order (lane S's solve/compile.ts methodCombinations). */
export const methodCombinations = (inputs: PlanInputs): ReadonlyArray<readonly MethodPick[]> =>
  inputs.methods.reduce<MethodPick[][]>((combos, method) => combos.flatMap(combo => method.options.map(option => [...combo, { choice: method.key, option: option.key }])), [[]])
const pickKey = (picks: readonly MethodPick[]): string => picks.map(pick => `${pick.choice}=${pick.option}`).sort().join('|')
const pickLabel = (picks: readonly MethodPick[], inputs: PlanInputs): string =>
  picks.map(pick => inputs.methods.find(choice => choice.key === pick.choice)?.options.find(option => option.key === pick.option)?.label ?? 'a method option no longer in this plan').join(', ')

/** What a rung allows, for its option's label: "days only", or "with" and the crew time it buys. */
const allowsOf = (rung: BuysRung, lowest: boolean, context: Context): string => {
  const own = crewTimeIn(rung.buy, context.inputs)
  if (lowest) return own.length === 0 ? 'days only' : `days only, with ${joinWords(own.map(context.names.purchase))} already ordered`
  return `with ${joinWords(own.map(context.names.purchase))}`
}

export interface MethodChoice { readonly value: string; readonly label: string }

export interface RungView {
  readonly rung: number
  /** "1", "2", "3": the rung's place on the ladder as a person counts it. */
  readonly step: string
  /** "Days only", "+ Station mechanical overtime to 19:00": what this rung adds to the one below. */
  readonly name: string
  /** What its option's label says it allows: "days only", "with Station mechanical overtime to 19:00". */
  readonly allows: string
  /** The top rung buys all crew time: its options are the plan's default options. */
  readonly top: boolean
  /** The purchase list its Generate sends, as the Module listed it. */
  readonly buy: readonly string[]
  /** Its option for the method shown, when one is solved on the current plan; null while it is still to work out. */
  readonly option: string | null
  readonly mark: Mark | null
  readonly tone: 'good' | 'refusal' | 'unknown' | 'warning'
  /** "Longest outage 56.5 h of 72 h · Extra cost NOK 398,800", "Not possible: …", or what its status says. */
  readonly outcome: string | null
  /** The crew time it uses: "Station mechanical overtime to 19:00: 54 person-hours". */
  readonly uses: readonly string[]
  readonly stale: boolean
}

export interface LadderRowView {
  readonly from: number
  readonly to: number
  /** The Module's word for the step, exactly: "makes it possible", "found", "proven: no gain", … */
  readonly word: BuysRow['word']
  /** "longest outage 2.5 h shorter · extra cost NOK 65,450 more", or null when the row gives no differences. */
  readonly differences: string | null
  /** What sets the finish on the higher rung, its names selectable, on every row that names it. */
  readonly finish: readonly Part[] | null
}

export interface LadderView {
  readonly rungs: readonly RungView[]
  readonly rows: readonly LadderRowView[]
  /** The rungs still to work out, lowest first: the order they are solved in, so no rung is solved above an unsolved one. */
  readonly toSolve: readonly RungView[]
  /** The methods that have a ladder, in plan order, and the one shown. */
  readonly methods: readonly MethodChoice[]
  readonly method: MethodChoice | null
}

/**
 * One ladder per method (U3), as the buys section gives them: each rung and row names the method picks it
 * belongs to, so the ladder shown holds that method's rungs and the rows between them, and never compares two
 * methods. Until the planner switches, the recommended option's method is shown.
 */
export const ladderView = (pages: readonly BuysPage[], model: PlanModel, context: Context, method: string | null): LadderView => {
  const items = pages.flatMap(page => page.items)
  const entries = items.flatMap(item => 'rung' in item ? [item.rung] : [])
  const order = methodCombinations(context.inputs).map(pickKey)
  const rank = (key: string) => { const at = order.indexOf(key); return at < 0 ? order.length : at }
  const keys = [...new Set(entries.map(entry => pickKey(entry.methods)))].sort((left, right) => rank(left) - rank(right))
  const methods = keys.map(key => ({ value: key, label: pickLabel(entries.find(entry => pickKey(entry.methods) === key)!.methods, context.inputs) }))
  const recommended = model.options?.items.find(item => item.key === model.options?.recommended)
  const chosen = methods.find(entry => entry.value === method) ?? methods.find(entry => recommended !== undefined && entry.value === pickKey(recommended.variant.methods)) ?? methods[0] ?? null
  const rungs = chosen === null ? [] : entries.filter(entry => pickKey(entry.methods) === chosen.value).sort((left, right) => left.rung - right.rung)
  const top = rungs.at(-1)?.rung
  const views = rungs.map((rung, index): RungView => {
    const option = rung.option === undefined ? undefined : model.options?.items.find(item => item.key === rung.option)
    const view = option === undefined ? null : statusView(option.status, context)
    return {
      rung: rung.rung, step: String(rung.rung + 1), name: rungName(rung, rungs[index - 1], context), allows: allowsOf(rung, index === 0, context), top: rung.rung === top, buy: rung.buy,
      option: option?.key ?? null, mark: view?.mark ?? null,
      tone: view === null || view.word === 'validated feasible' ? 'good' : view.word === 'proven infeasible' ? 'refusal' : view.word === 'unresolved' ? 'unknown' : 'warning',
      outcome: option === undefined ? null : outcomeOf(option, model, context),
      uses: option === undefined || option.status.word !== 'validated feasible' ? [] : usesOf(rung, context),
      stale: option !== undefined && !option.fresh,
    }
  })
  const rows = chosen === null ? [] : items.flatMap(item => 'row' in item && pickKey(item.row.methods) === chosen.value ? [item.row] : []).sort((left, right) => left.from - right.from).map((row): LadderRowView => ({
    from: row.from, to: row.to, word: row.word,
    differences: differenceText(row, context.inputs.settings.currency),
    finish: row.finish === undefined ? null : causeParts(row.finish, context),
  }))
  return { rungs: views, rows, toSolve: views.filter(rung => rung.option === null), methods, method: chosen }
}

/**
 * The one Generate a rung is solved by (U1, lane S's solve/ladder.ts): below the top, one variant per method
 * combination with the rung's buy list, labelled "<method>: <what it allows>"; the top rung is a plain Generate,
 * so its options are the default options, with their keys and their method's label. Each is kept beside the
 * options already there.
 */
export const rungRequest = (rung: Pick<RungView, 'top' | 'buy' | 'allows'>, context: Context): { readonly variants?: Array<{ readonly label: string; readonly methods: MethodPick[]; readonly buy: string[] }>; readonly keep: true } => {
  if (rung.top) return { keep: true }
  return {
    variants: methodCombinations(context.inputs).map(combo => {
      const methods = pickLabel(combo, context.inputs)
      return { label: methods === '' ? `${rung.allows.charAt(0).toUpperCase()}${rung.allows.slice(1)}` : `${methods}: ${rung.allows}`, methods: combo.map(pick => ({ ...pick })), buy: [...rung.buy] }
    }),
    keep: true,
  }
}

/** Under the rows: where a finer trade is asked. */
export const finerTrade = 'For a finer trade, ask for “at most … h out”.'

/** What each ladder word claims, in one line under the rows. */
export const ladderLegend = 'makes it possible: the lower rung is proven impossible · found: a better plan was found, not proven best · proven: both rungs are proven best on the outage · proven: no gain: both proven, with the same outage · not found better: the search found no shorter outage · not solved: a rung stopped before it found a plan'

/**
 * What a re-timing uses beyond the planned rows (lane K's `extra.bought`), in the ladder's units and words:
 * "10.5 more person-hours of Station mechanical crew overtime to 19:00", "1 more night of Contractor night
 * crew (nights Mon to Thu)". Only purchases it uses more of.
 */
export const extraUseText = (bought: ReadonlyArray<{ readonly purchase: string; readonly value: number; readonly unit: string }>, context: Context): readonly string[] =>
  bought.filter(item => item.value > 0).flatMap(item => {
    const purchase = context.inputs.purchases.find(entry => entry.key === item.purchase)
    if (purchase === undefined) return []
    if (item.unit === 'person-h') return [`${hoursNumber(item.value)} more person-hours of ${purchase.label}`]
    if (isTimeUnit(item.unit)) return [`${hoursNumber(item.value * timeUnitMs[item.unit] / timeUnitMs.h)} more person-hours of ${purchase.label}`]
    if (item.unit !== 'periods') return [`${quantityText(item.value, item.unit)} more of ${purchase.label}`]
    const word = periodWord(context.inputs, purchase.key, context.format)
    return [`${hoursNumber(item.value)} more ${item.value === 1 ? word.one : word.many} of ${purchase.label}`]
  })
