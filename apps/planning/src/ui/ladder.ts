// "What overtime buys" (design §4.1): the rungs of bought crew time and the rows between two rungs, as
// planning.plan.read section buys gives them. Each row's word is the Module's own, shown exactly; the
// differences are the Module's, in hours and money; what each rung uses is the checker's own measure. A rung
// is named by what it buys, from the plan's purchases. Nothing here compares or ranks options.
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

export interface RungView {
  readonly rung: number
  /** "1", "2", "3": the rung's place on the ladder as a person counts it. */
  readonly step: string
  /** "Days only", "+ Station mechanical overtime to 19:00": what this rung adds to the one below. */
  readonly name: string
  /** "Rung 2 of 3: + Station mechanical overtime to 19:00": the name its option has among the plan's options. */
  readonly label: string
  /** The purchase list its Generate sends, as the Module listed it. */
  readonly buy: readonly string[]
  /** Its option, when one is solved on the current plan; null while it is still to work out. */
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
  /** "2.5 h shorter outage · NOK 65,450 more", or null when the row gives no differences. */
  readonly differences: string | null
  /** With "proven: no gain": what sets the finish on the higher rung, its names selectable. */
  readonly finish: readonly Part[] | null
}

export interface LadderView {
  readonly rungs: readonly RungView[]
  readonly rows: readonly LadderRowView[]
  /** The rungs still to work out, lowest first: the order they are solved in, so no rung is solved above an unsolved one. */
  readonly toSolve: readonly RungView[]
}

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

/** A row's differences in words: the higher rung against the lower, in hours of outage and in money. */
export const differenceText = (row: Pick<BuysRow, 'outage' | 'cost'>, currency: string): string | null => {
  if (row.outage === undefined || row.cost === undefined) return null
  const outage = row.outage < 0 ? `${hoursText(-row.outage)} shorter outage` : row.outage > 0 ? `${hoursText(row.outage)} longer outage` : 'the same outage'
  const cost = row.cost > 0 ? `${moneyText(row.cost, currency)} more` : row.cost < 0 ? `${moneyText(-row.cost, currency)} less` : 'the same extra cost'
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

export const ladderView = (pages: readonly BuysPage[], model: PlanModel, context: Context): LadderView => {
  const items = pages.flatMap(page => page.items)
  const rungs = items.flatMap(item => 'rung' in item ? [item.rung] : []).sort((left, right) => left.rung - right.rung)
  const views = rungs.map((rung, index): RungView => {
    const option = rung.option === undefined ? undefined : model.options?.items.find(item => item.key === rung.option)
    const view = option === undefined ? null : statusView(option.status, context)
    const name = rungName(rung, rungs[index - 1], context)
    return {
      rung: rung.rung, step: String(rung.rung + 1), name, label: `Rung ${rung.rung + 1} of ${rungs.length}: ${name}`, buy: rung.buy,
      option: option?.key ?? null, mark: view?.mark ?? null,
      tone: view === null || view.word === 'validated feasible' ? 'good' : view.word === 'proven infeasible' ? 'refusal' : view.word === 'unresolved' ? 'unknown' : 'warning',
      outcome: option === undefined ? null : outcomeOf(option, model, context),
      uses: option === undefined || option.status.word !== 'validated feasible' ? [] : usesOf(rung, context),
      stale: option !== undefined && !option.fresh,
    }
  })
  const rows = items.flatMap(item => 'row' in item ? [item.row] : []).sort((left, right) => left.from - right.from).map((row): LadderRowView => ({
    from: row.from, to: row.to, word: row.word,
    differences: differenceText(row, context.inputs.settings.currency),
    finish: row.word === 'proven: no gain' && row.finish !== undefined ? causeParts(row.finish, context) : null,
  }))
  return { rungs: views, rows, toSolve: views.filter(rung => rung.option === null) }
}

/** The one Generate a rung is solved by: its purchases, kept beside the options already there. */
export const rungRequest = (rung: Pick<RungView, 'label' | 'buy'>) => ({ variants: [{ label: rung.label, buy: [...rung.buy] }], keep: true as const })

/** Under the rows: where a finer trade is asked. */
export const finerTrade = 'For a finer trade, ask for “at most … h out”.'
