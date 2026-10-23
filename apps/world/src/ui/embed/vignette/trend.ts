// Trend strips (architecture B, W5): one quantity on each strip (strips.ts), its recorded points drawn step-and-hold,
// a value holding until the next for as long as the Historian's hold served with its record and broken where the
// record is silent longer, so missing data shows; the time before the record starts left quiet ("No record yet").
// Its limits are the alarm and trip limits every pen on it declares at one value: neutral dashes that take their
// alarm's colour only while a value is past them where they act now, faint where they do not act now (another mode, a
// condition that does not hold: the observation's `idle`), named outside the plot by their step from normal, value and
// consequence, so the names read in value order. No two names touch: where the room is short the least telling gives
// way, never one a value is past or heading for. An element's own trend marks its control set points faint ("CTL").
// Pens are told apart by dash, colour is kept for alerts.
import { priorityLevels } from '../../../core/model/alerts.ts'
import { decadeParts, numberShown, numberStep, numberText, shownFactor, unitSymbol, type Observable, type Observation, type Quantity } from '../../../core/observation/model.ts'
import type { RecordedSeries, SeriesPoint, VignetteValue } from '../../../features/displays/compose/model.ts'
import { drawsAsLimit } from '../../../features/displays/compose/strips.ts'
import { orderWord, toneOf, type AlertTone } from './readout.ts'

type Threshold = Observable['thresholds'][number]

export interface Window {
  readonly start: number
  readonly end: number
}

/**
 * A pen's record as a display draws it: the record served with its hold, the live points after it, and from when its
 * reading has measured nothing (bad, or outside its declared validity), which its last value holds no further.
 */
export interface DrawnSeries extends RecordedSeries {
  readonly silentFrom?: number
}

/** Where a point's value ends: at the next point, at its hold, at the window's end, or the last where its reading went silent, whichever comes first. */
const heldUntil = (points: ReadonlyArray<SeriesPoint>, index: number, end: number, holdMs: number, silentFrom?: number): number => {
  const point = points[index]!
  const next = points[index + 1]?.t ?? (silentFrom !== undefined && silentFrom >= point.t ? silentFrom : end)
  return Math.min(next, point.t + holdMs, end)
}

/** Step-and-hold SVG path: each point holds until the next, until `window.end` at most, and breaks where the next comes after its hold or the reading went silent. */
export const stepPath = (points: ReadonlyArray<SeriesPoint>, x: (t: number) => number, y: (v: number) => number, window: Window, holdMs: number, silentFrom?: number): string => {
  const commands: string[] = []
  let open = false
  points.forEach((point, index) => {
    const next = points[index + 1]
    const holdEnd = heldUntil(points, index, window.end, holdMs, silentFrom)
    if (holdEnd < window.start || point.t > window.end) { open = false; return }
    const level = y(point.v).toFixed(1)
    commands.push(`${open ? 'L' : 'M'}${x(Math.max(point.t, window.start)).toFixed(1)} ${level}`, `L${x(holdEnd).toFixed(1)} ${level}`)
    open = next !== undefined && next.t <= point.t + holdMs
  })
  return commands.join(' ')
}

/** A state's band: the stretches its record holds it on or off, as step-and-hold does, where it holds one; alike stretches that meet are one. */
export const bandStretches = (points: ReadonlyArray<SeriesPoint>, x: (t: number) => number, window: Window, holdMs: number, silentFrom?: number): ReadonlyArray<{ readonly x: number; readonly width: number; readonly on: boolean }> => {
  const stretches: Array<{ x: number; width: number; on: boolean }> = []
  points.forEach((point, index) => {
    const until = heldUntil(points, index, window.end, holdMs, silentFrom)
    if (until < window.start || point.t > window.end) return
    const from = x(Math.max(point.t, window.start))
    const last = stretches.at(-1)
    if (last !== undefined && last.on === (point.v !== 0) && Math.abs(last.x + last.width - from) < 0.5) last.width = Math.max(0, x(until) - last.x)
    else stretches.push({ x: from, width: Math.max(0, x(until) - from), on: point.v !== 0 })
  })
  return stretches
}

/** A live point added to a pen's record, which keeps its window and the one point before it (the value held at its start). */
export const appendPoint = (points: ReadonlyArray<SeriesPoint>, point: SeriesPoint, windowStart: number): ReadonlyArray<SeriesPoint> => {
  const kept = [...points.filter(existing => existing.t < point.t), point]
  const first = kept.findIndex(existing => existing.t >= windowStart)
  return first <= 0 ? kept : kept.slice(first - 1)
}

/** The value a record holds at `t`: its last point then, while its hold lasts. */
const heldAt = (points: ReadonlyArray<SeriesPoint>, t: number, holdMs: number): number | undefined => {
  let point: SeriesPoint | undefined
  for (const candidate of points) if (candidate.t <= t) point = candidate
  return point === undefined || t - point.t > holdMs ? undefined : point.v
}

/**
 * A value's rate per minute now: its change over the last 30 s, where that and its change over 2 min agree in
 * direction and each is at least a step of its decimals (W4.2's rule); null where they do not or the record is shorter.
 */
export const rateNow = (series: Pick<DrawnSeries, 'points' | 'holdMs'>, now: number, step: number): number | null => {
  const [value, before, longBefore] = [now, now - 30_000, now - 120_000].map(t => heldAt(series.points, t, series.holdMs))
  if (value === undefined || before === undefined || longBefore === undefined) return null
  const [short, long] = [value - before, value - longBefore]
  return Math.abs(short) >= step && Math.abs(long) >= step && Math.sign(short) === Math.sign(long) ? short * 2 : null
}

/** A rate as a legend reads it: "▼ 0.12/min", at its value's decimals. */
export const rateText = (rate: number, unit: string, quantity?: Quantity): string => `${rate > 0 ? '▲' : '▼'} ${numberText(Math.abs(rate), unit, quantity)}/min`

/** A line: the limits (or control set points) every pen on a strip declares at one value and direction, each pen's own, whatever each calls them. */
export interface LimitLine {
  readonly key: string
  readonly value: number
  readonly direction: 'low' | 'high'
  readonly byPen: ReadonlyArray<ReadonlyArray<Threshold>>
}

/** A strip's limit lines (`setPoints`: its control set points and targets instead): where every pen declares one at that value and direction. */
export const sharedLines = (pens: ReadonlyArray<Pick<VignetteValue, 'thresholds'>>, setPoints = false): ReadonlyArray<LimitLine> => {
  const of = (pen: Pick<VignetteValue, 'thresholds'>): ReadonlyArray<Threshold> => pen.thresholds.filter(threshold => drawsAsLimit(threshold) !== setPoints)
  const first = pens[0]
  if (first === undefined) return []
  const keys = [...new Map(of(first).map(threshold => [`${threshold.direction} ${threshold.value}`, threshold] as const)).entries()]
  return keys.flatMap(([key, { value, direction }]) => {
    const byPen = pens.map(pen => of(pen).filter(other => other.direction === direction && other.value === value))
    return byPen.every(limits => limits.length > 0) ? [{ key, value, direction, byPen }] : []
  })
}

export interface Domain {
  readonly min: number
  readonly max: number
}

const PAD = 0.08
// A steady value is not magnified into noise: a scale spans at least this share of the value, and twenty steps of its decimals.
const MIN_SPAN_SHARE = 0.04
const MIN_SPAN_STEPS = 20

/** Whether a limit is near enough to share the values' scale (within three spreads or a quarter of their size); a farther one would flatten them. */
export const limitInReach = (limit: number, values: Domain): boolean => {
  const reach = Math.max(3 * (values.max - values.min), 0.25 * Math.max(Math.abs(values.max), Math.abs(values.min)))
  return limit >= values.min - reach && limit <= values.max + reach
}

/** The strip's scale: the values seen, widened to a minimum span and to the limits in reach, padded. */
export const stripDomain = (seen: Domain, limits: ReadonlyArray<number>, decimals: number): Domain => {
  const middle = (seen.min + seen.max) / 2
  const minimum = Math.max(Math.abs(middle) * MIN_SPAN_SHARE, MIN_SPAN_STEPS * 10 ** -decimals)
  const core = seen.max - seen.min >= minimum ? seen : { min: middle - minimum / 2, max: middle + minimum / 2 }
  const reached = limits.filter(limit => limitInReach(limit, seen))
  const low = Math.min(core.min, ...reached)
  const high = Math.max(core.max, ...reached)
  return { min: low - (high - low) * PAD, max: high + (high - low) * PAD }
}

const niceStep = (span: number, count: number): number => {
  const rough = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  return (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude
}

/** Two to four gridlines at round values; labels share the step's precision. */
export const valueTicks = (domain: Domain): ReadonlyArray<{ readonly value: number; readonly label: string }> => {
  const step = niceStep(domain.max - domain.min, 3)
  const digits = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)))
  const ticks: Array<{ value: number; label: string }> = []
  for (let tick = Math.ceil(domain.min / step) * step; tick <= domain.max + step * 1e-9; tick += step) ticks.push({ value: tick, label: tick.toFixed(digits) })
  return ticks
}

const tickStepMs = (windowMs: number): number =>
  windowMs <= 150_000 ? 30_000 : windowMs <= 300_000 ? 60_000 : windowMs <= 600_000 ? 120_000 : windowMs <= 1_200_000 ? 300_000 : 600_000

/** Times counted back from now in round steps: "now", "−2 min", "−30 s". */
export const timeTicks = (now: number, windowMs: number): ReadonlyArray<{ readonly t: number; readonly label: string }> => {
  const step = tickStepMs(windowMs)
  const ticks: Array<{ t: number; label: string }> = []
  for (let back = 0; back <= windowMs; back += step) {
    ticks.unshift({ t: now - back, label: back === 0 ? 'now' : back % 60_000 === 0 ? `−${back / 60_000} min` : `−${back / 1000} s` })
  }
  return ticks
}

/** Dash patterns that tell a strip's pens apart, in order (a strip holds at most four pens). */
export const PEN_DASHES: ReadonlyArray<string> = ['', '6 3', '2 3', '8 3 2 3']

/** One place a name wants along the plot's edge: kept by rank (lowest first) while all fit. */
export interface LabelSlot {
  readonly key: string
  /** Where it starts at its line. */
  readonly want: number
  readonly size: number
  readonly rank: number
}

/**
 * Names down the plot's edge (after OLD's stackLabels): kept by rank while they fit the room, the most telling always,
 * then placed in order, each at its line or pushed just clear of the one before, and pulled back from the room's end
 * so the last stays inside. Names that read in an order keep it where several want one place; the rest give way.
 */
export const stackLabels = (slots: ReadonlyArray<LabelSlot>, room: Domain): ReadonlyArray<{ readonly key: string; readonly start: number }> => {
  const kept = new Set<LabelSlot>()
  let used = 0
  for (const slot of [...slots].sort((left, right) => left.rank - right.rank)) {
    if (kept.size > 0 && used + slot.size > room.max - room.min) continue
    kept.add(slot)
    used += slot.size
  }
  const ordered = slots.filter(slot => kept.has(slot)).sort((left, right) => left.want - right.want)
  const starts = ordered.map(slot => slot.want)
  for (let index = 0; index < ordered.length; index += 1) starts[index] = Math.max(starts[index]!, index === 0 ? room.min : starts[index - 1]! + ordered[index - 1]!.size)
  for (let index = ordered.length - 1; index >= 0; index -= 1) starts[index] = Math.min(starts[index]!, index === ordered.length - 1 ? room.max - ordered[index]!.size : starts[index + 1]! - ordered[index]!.size)
  return ordered.map((slot, index) => ({ key: slot.key, start: starts[index]! }))
}

/** A run of a name's text: idle words faint; a limit a value is past bold, led by a mark in its alarm's colour (`mark`). */
export interface LabelRun { readonly text: string; readonly idle: boolean; readonly tone: AlertTone | null; readonly mark?: true }

/** How a name's text fits its room: as many whole runs on each row as fit, a run longer than the room alone on its row. */
export const labelRows = (runs: ReadonlyArray<LabelRun>, room: number, measure: (text: string) => number): ReadonlyArray<ReadonlyArray<LabelRun>> => {
  const rows: LabelRun[][] = []
  for (const run of runs) {
    const row = rows.at(-1)
    const text = (entries: ReadonlyArray<LabelRun>) => entries.map(entry => entry.text).join('')
    if (row !== undefined && measure(text([...row, run])) <= room) row.push(run)
    else rows.push([{ ...run, text: run.text.replace(/^ /, '') }])
  }
  return rows
}

/** A limit name's row (TrendStrip.svelte): 12 px Noto Sans, whose glyph box is about 16.3 px tall, so the boxes of two rows never meet. */
export const LABEL_LINE = 17
/** A name's inset from the plot, after its leader; continued rows indent further. */
export const LABEL_GAP = 8
export const LABEL_INDENT = 8
// The plot keeps its lines this far from its top and bottom edges.
const INSET = 4

export interface StripInput {
  readonly pens: ReadonlyArray<VignetteValue>
  /** Each pen's record by ref, with its hold. */
  readonly series: ReadonlyMap<string, DrawnSeries>
  readonly observations: ReadonlyArray<Pick<Observation, 'ref' | 'priority' | 'value' | 'idle'>>
  readonly now: number
  readonly horizonMs: number
  readonly height: number
  /** An element's own trend marks its control set points ("CTL"). */
  readonly setPoints: boolean
}

interface Named {
  readonly key: string
  readonly value: number
  readonly edge: 'top' | 'bottom' | null
  readonly runs: ReadonlyArray<LabelRun>
  readonly idle: boolean
  readonly tone: AlertTone | null
  readonly rank: ReadonlyArray<number>
  readonly title: string
}

const TONES: ReadonlyArray<AlertTone> = ['caution', 'warning', 'alarm', 'critical']
const worstTone = (tones: ReadonlyArray<AlertTone | null>): AlertTone | null => tones.reduce<AlertTone | null>((worst, tone) => (tone !== null && (worst === null || TONES.indexOf(tone) > TONES.indexOf(worst)) ? tone : worst), null)

/** What a strip shows over its window ending now, before it is laid out: its pens' points, its scale, and its named lines. */
const readStrip = (input: StripInput) => {
  const window = { start: input.now - input.horizonMs, end: input.now }
  // What each pen draws: every point whose value holds into the window.
  const held = input.pens.map(pen => {
    const recorded = input.series.get(pen.ref)
    return recorded === undefined ? [] : recorded.points.filter((point, index, points) => point.t <= window.end && heldUntil(points, index, window.end, recorded.holdMs, recorded.silentFrom) >= window.start)
  })
  const shown = held.flat().map(point => point.v)
  if (shown.length === 0) return null
  const recordStart = Math.max(window.start, Math.min(...held.flatMap(points => (points.length === 0 ? [] : [points[0]!.t]))))
  const { unit, quantity, decades } = input.pens[0]!
  // A strip is scaled in the unit its values are shown in (pascals in kilopascals); one of values read over decades by
  // their powers of ten, at least two decades tall, a value of none at its foot.
  const factor = shownFactor(unit)
  const scaled = (value: number): number => (decades !== true ? value * factor : value > 0 ? Math.log10(value) : -Infinity)
  const seenScaled = shown.map(scaled).filter(Number.isFinite)
  if (seenScaled.length === 0) return null
  const seen = { min: Math.min(...seenScaled), max: Math.max(...seenScaled) }
  const lines = sharedLines(input.pens)
  const domain = stripDomain(seen, lines.map(line => scaled(line.value)).filter(Number.isFinite), decades === true ? 1 : numberShown(Math.max(...shown.map(Math.abs)), unit, quantity).decimals)
  const observed = input.pens.map(pen => input.observations.find(observation => observation.ref === pen.ref))
  const idle = (pen: number, limit: Threshold): boolean => observed[pen]?.idle?.includes(limit.id) === true
  const valueNow = (pen: number): number | undefined => (typeof observed[pen]?.value === 'number' ? observed[pen]!.value as number : undefined)
  const step = numberStep(Math.max(...shown.map(Math.abs)), unit, quantity)
  const rates = input.pens.map(pen => { const recorded = input.series.get(pen.ref); return recorded === undefined ? null : rateNow(recorded, input.now, step) })
  const number = (value: number): string => numberText(value, unit, quantity, decades === true)
  // A value heads for the nearest limit ahead in the way it moves; held steady, for the nearest on either side.
  const ahead = new Set(input.pens.flatMap((_, pen) => {
    const value = valueNow(pen)
    if (value === undefined) return []
    const above = lines.filter(line => line.value > value).sort((left, right) => left.value - right.value)[0]
    const below = lines.filter(line => line.value < value).sort((left, right) => right.value - left.value)[0]
    const rate = rates[pen] ?? null
    return (rate === null ? [above, below] : rate > 0 ? [above] : [below]).flatMap(line => line?.key ?? [])
  }))
  const inside = (value: number): boolean => scaled(value) >= domain.min && scaled(value) <= domain.max
  // Beyond the scale, each edge names the limit nearest it: the one the value would meet next.
  const beyond = new Set([
    ...lines.filter(line => scaled(line.value) > domain.max).sort((left, right) => left.value - right.value).slice(0, 1),
    ...lines.filter(line => scaled(line.value) < domain.min).sort((left, right) => right.value - left.value).slice(0, 1),
  ])
  const named: Named[] = lines.filter(line => inside(line.value) || beyond.has(line)).map(line => {
    const members = line.byPen.flatMap((limits, pen) => limits.map(limit => ({ limit, idle: idle(pen, limit) })))
    const lineIdle = members.every(member => member.idle)
    // Coloured while a value is past it where it acts now, in the colour its own alarm takes, as the value is coloured.
    const tone = worstTone(line.byPen.flatMap((limits, pen) => {
      const value = valueNow(pen)
      const past = value !== undefined && toneOf(observed[pen]?.priority) !== null && (line.direction === 'low' ? value < line.value : value > line.value)
      return past ? limits.filter(limit => !idle(pen, limit)).map(limit => toneOf(limit.priority)) : []
    }))
    const consequences = [...new Map([...members].sort((left, right) => Number(left.idle) - Number(right.idle)).flatMap(member => member.limit.consequence === undefined ? [] : [[member.limit.consequence, member.idle] as const])).entries()]
      .map(([text]) => ({ text, idle: members.filter(member => member.limit.consequence === text).every(member => member.idle) }))
    const edge = inside(line.value) ? null : scaled(line.value) > domain.max ? 'top' as const : 'bottom' as const
    const head = `${edge === null ? '' : edge === 'top' ? '▲ ' : '▼ '}${orderWord(line.byPen[0]![0]!)} ${number(line.value)}`
    const runs: LabelRun[] = [
      ...(tone === null ? [] : [{ text: '■ ', idle: false, tone, mark: true as const }]),
      { text: head, idle: lineIdle, tone },
      ...consequences.map((part, at) => ({ text: `${at === 0 ? ' · ' : ' + '}${part.text}`, idle: part.idle, tone: part.idle ? null : tone })),
    ]
    const distance = Math.min(...input.pens.map((_, pen) => Math.abs((valueNow(pen) ?? line.value) - line.value)))
    const priority = Math.max(...members.filter(member => !member.idle || lineIdle).map(member => priorityLevels.indexOf(member.limit.priority)))
    const when = [...new Set(members.flatMap(member => member.limit.when ?? []))]
    return {
      key: line.key, value: line.value, edge, runs, idle: lineIdle, tone,
      // Past it first (the worst first), then what a value heads for, then those that act now by priority, nearest first; idle ones last.
      rank: [tone !== null ? 0 : ahead.has(line.key) ? 1 : lineIdle ? 3 : 2, -(tone === null ? priority : TONES.indexOf(tone)), distance],
      title: `${runs.map(run => run.text).join('')}${when.length === 0 ? '' : ` (${when.join('; ')})`}${lineIdle ? ' · does not act now' : ''}`,
    }
  })
  // Control set points the element's own trend marks, inside its scale only: they never widen it.
  const setPoints = input.setPoints ? sharedLines(input.pens, true).filter(line => inside(line.value)) : []
  return { window, held, recordStart, domain, scaled, decades: decades === true, named, setPoints, number }
}

/** Gridlines of a strip over decades: its whole powers of ten, written "10⁻⁶". */
const decadeTicks = (domain: Domain): ReadonlyArray<{ readonly value: number; readonly label: string }> => {
  const step = Math.max(1, Math.round(niceStep(domain.max - domain.min, 3)))
  const ticks: Array<{ value: number; label: string }> = []
  for (let power = Math.ceil(domain.min / step) * step; power <= domain.max; power += step) ticks.push({ value: power, label: decadeParts(10 ** power).text.replace(/^1\.0×/, '') })
  return ticks
}

/** The widest one-row name a strip writes beside its plot (0 without any): the strips of one trend share the widest as their margin. */
export const labelWidth = (input: StripInput, measure: (text: string) => number): number => {
  const read = readStrip(input)
  return Math.max(0, ...(read?.named ?? []).map(entry => measure(entry.runs.map(run => run.text).join(''))), ...(read?.setPoints ?? []).map(line => measure(`CTL ${read!.number(line.value)}`)))
}

export interface StripDrawing {
  readonly pens: ReadonlyArray<{ readonly ref: string; readonly path: string; readonly dash: string; readonly tone: AlertTone | null }>
  /** Limit lines inside the scale: faint where none acts now, coloured while a value is past one that acts. */
  readonly lines: ReadonlyArray<{ readonly key: string; readonly y: number; readonly idle: boolean; readonly tone: AlertTone | null; readonly title: string }>
  /** Each kept name beside the plot: its rows from `y` (the first row's middle), and its line's `y` (null beyond the scale). */
  readonly labels: ReadonlyArray<{ readonly key: string; readonly lineY: number | null; readonly y: number; readonly rows: ReadonlyArray<ReadonlyArray<LabelRun>>; readonly title: string }>
  /** Control set points: a faint tick at the plot's edge, named faint ("CTL 15.35") only where no limit's name stands (`labelY` null otherwise). */
  readonly setPoints: ReadonlyArray<{ readonly key: string; readonly y: number; readonly label: string; readonly labelY: number | null; readonly title: string }>
  /** Gridlines, and where each one's value is written: above it, or below where it would leave the plot. */
  readonly values: ReadonlyArray<{ readonly y: number; readonly labelY: number; readonly label: string }>
  /** The window's time before any pen's record starts, from its left edge: "No record yet"; null where a record reaches its start. */
  readonly unrecorded: { readonly width: number } | null
}

/** A strip as drawn over its window ending now on a plot `width` wide, its names in `room` beside it; null while none of its pens has a value in the window. */
export const stripDrawing = (input: StripInput & { readonly width: number; readonly room: number; readonly measure: (text: string) => number }): StripDrawing | null => {
  const read = readStrip(input)
  if (read === null) return null
  const { window, domain, named } = read
  const x = (t: number): number => ((t - window.start) / input.horizonMs) * input.width
  const at = (position: number): number => INSET + (1 - (position - domain.min) / (domain.max - domain.min)) * (input.height - 2 * INSET)
  const y = (v: number): number => Math.min(input.height - INSET, at(read.scaled(v)))
  const rows = new Map(named.map(entry => [entry.key, labelRows(entry.runs, input.room - LABEL_GAP, input.measure)] as const))
  const ranked = named.map((_, index) => index).sort((left, right) => compareRanks(named[left]!.rank, named[right]!.rank))
  const placed = stackLabels(named.map((entry, index) => {
    const size = rows.get(entry.key)!.length * LABEL_LINE
    return { key: entry.key, want: entry.edge === 'top' ? 0 : entry.edge === 'bottom' ? input.height - size : y(entry.value) - LABEL_LINE / 2, size, rank: ranked.indexOf(index) }
  }), { min: 0, max: input.height })
  const byKey = new Map(named.map(entry => [entry.key, entry] as const))
  const taken = placed.map(label => [label.start, label.start + rows.get(label.key)!.length * LABEL_LINE] as [number, number])
  const ticks = read.decades ? decadeTicks(domain) : valueTicks(domain)
  const top = Math.min(...ticks.map(tick => at(tick.value)))
  const unit = unitSymbol(input.pens[0]!.unit)
  return {
    pens: input.pens.map((pen, index) => {
      const recorded = input.series.get(pen.ref)
      return {
        ref: pen.ref,
        path: recorded === undefined ? '' : stepPath(recorded.points, x, y, window, recorded.holdMs, recorded.silentFrom),
        dash: PEN_DASHES[index % PEN_DASHES.length]!,
        tone: toneOf(input.observations.find(observation => observation.ref === pen.ref)?.priority),
      }
    }),
    lines: named.filter(entry => entry.edge === null).map(entry => ({ key: entry.key, y: y(entry.value), idle: entry.idle, tone: entry.tone, title: entry.title })),
    labels: placed.map(label => {
      const entry = byKey.get(label.key)!
      return { key: label.key, lineY: entry.edge === null ? y(entry.value) : null, y: label.start + LABEL_LINE / 2, rows: rows.get(label.key)!, title: entry.title }
    }),
    setPoints: read.setPoints.map(line => {
      const level = y(line.value)
      // A set point's name takes only room no limit's name stands in, at its own line: it never moves one.
      const start = level - LABEL_LINE / 2
      const free = start >= 0 && start + LABEL_LINE <= input.height && !taken.some(([from, to]) => start < to && from < start + LABEL_LINE)
      if (free) taken.push([start, start + LABEL_LINE])
      return {
        key: line.key, y: level, label: `CTL ${read.number(line.value)}`, labelY: free ? level : null,
        title: `CTL ${read.number(line.value)}${[...new Set(line.byPen.flat().flatMap(limit => limit.consequence === undefined || limit.consequence === 'CTL' ? [] : [limit.consequence]))].map(text => ` · ${text}`).join('')}: control set point`,
      }
    }),
    // The top value names the unit; a value too near the top is written under its line, so none leaves the plot.
    values: ticks.map(tick => {
      const level = at(tick.value)
      return { y: level, labelY: level - 3 < 14 ? level + 12 : level - 3, label: level === top && unit !== '' ? `${tick.label} ${unit}` : tick.label }
    }),
    unrecorded: read.recordStart > window.start ? { width: x(read.recordStart) } : null,
  }
}

const compareRanks = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
