import { SUGGESTION_COUNT, editDistance, letters, matchedWords, normalized, words } from './name-matching.ts'
import { z } from 'zod'
import { recordingSeriesIdFor } from '../../../core/model/index.ts'
import type {
  ProcessQuantity,
  ProcessSignalBinding,
  ProcessUnit,
  ProcessVariableLimits,
  VariablePath,
} from '../graph/index.ts'
import { processSignalTagIdSchema, variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { findProcessPlantSignalBinding } from '../signals.ts'
import {
  COMPOSED_DISPLAY_MAX_HEIGHT_PX,
  COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX,
  composedDisplayLayout,
  composedDisplayMaxHeight,
  composedPanelMinimumHeight,
  COMPOSED_DISPLAY_MAX_SAMPLE_PATHS,
  COMPOSED_DISPLAY_MAX_TRENDS,
  COMPOSED_TREND_MAX_SIGNALS,
  COMPOSED_TREND_MAX_STRIPS,
  COMPOSED_TREND_STRIP_MAX_PENS,
  composedDisplayCompositionSchema,
  composedPanelHeight,
  fitComposedDisplay,
  composedDisplayHorizonMs,
  type ComposedDisplayComposition,
  type ComposedDisplayHorizon,
  type ComposedDisplayPanel,
  type ComposedDisplaySignal,
  type ComposedDisplaySignalRole,
  type ComposedPanelShape,
  type ComposedPanelSize,
} from './composition.ts'
import { formatQuantity, marginText, nearestThresholdMargin, thresholdName } from './display-text.ts'
import { compileMimic, compileMimicScope } from './mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH } from './mimic/mimic-model.ts'
import { chatMimicProfile, overviewMimicProfile } from './mimic/profiles.ts'
import { principalCircuits } from './mimic/principal.ts'
import { overviewKeyValues } from './overview-key-values.ts'
import type { CompiledMimic } from './mimic/mimic-model.ts'
import {
  icAlarmRuleIdsForEquipment,
  icThresholdsForSignal,
  type ComposedDisplayCombinedRule,
  type ComposedDisplayThreshold,
} from './ic-thresholds.ts'

export interface ComposedDisplayPen {
  readonly ref: string
  readonly role: ComposedDisplaySignalRole
  readonly path: VariablePath
  readonly tagId?: string
  readonly label: string
  /** What operators call it: the tag, or the label with its equipment ("Feedwater inflow · Steam Generator B"). */
  readonly name: string
  /** One measurement across parallel equipment ("steam-generator.levelPercent|percent"); pens sharing it share an axis. */
  readonly measurement: string
  readonly unit: ProcessUnit
  readonly quantity: ProcessQuantity
  readonly valueKind: 'number' | 'boolean'
  readonly seriesId: string
  /** Recorded by this Run's historian, so a trend has history from before the view opened. */
  readonly recorded: boolean
  /**
   * A writable operator or automation command (a demand), not a measured
   * state: a valve's commanded position can read closed while the valve is
   * stuck open. Shown as "demand" wherever it appears.
   */
  readonly command: boolean
  readonly limits?: ProcessVariableLimits
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly combinedRules: ReadonlyArray<ComposedDisplayCombinedRule>
}

/** A threshold drawn on a panel: one per distinct rule action of the primary signals. */
export interface ComposedTrendThreshold extends ComposedDisplayThreshold {
  /** Every rule merged into this line, so an active alarm on any of them marks it. */
  readonly ruleIds: ReadonlyArray<string>
  /** Tags or paths of the signals these rules act on. */
  readonly signals: ReadonlyArray<string>
}

/** One value axis of a trend: one measurement of parallel equipment, and its thresholds. */
export interface ComposedTrendStrip {
  readonly unit: ProcessUnit
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  readonly thresholds: ReadonlyArray<ComposedTrendThreshold>
}

/** Strips stacked on one time axis, the strip with the primary signal on top. */
export interface ComposedTrendPanel {
  readonly kind: 'trend'
  readonly horizon: ComposedDisplayHorizon
  readonly horizonMs: number
  readonly strips: ReadonlyArray<ComposedTrendStrip>
  /** Signals this Run does not record: shown as live values beside the trend, never as empty plots. */
  readonly live: ReadonlyArray<ComposedDisplayPen>
  /** Plot height of each strip, fitted to the display. */
  readonly plot: number
}

export interface ComposedComparisonPanel {
  readonly kind: 'comparison'
  readonly unit: ProcessUnit
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  readonly thresholds: ReadonlyArray<ComposedTrendThreshold>
}

export interface ComposedReadoutsPanel {
  readonly kind: 'readouts'
  readonly pens: ReadonlyArray<ComposedDisplayPen>
}

export interface ComposedAlarmsPanel {
  readonly kind: 'alarms'
  readonly scope: 'related' | 'plant'
  /** I&C rules acting on the displayed signals; used when scope is related. */
  readonly ruleIds: ReadonlyArray<string>
}

export interface ComposedMimicPanel {
  readonly kind: 'mimic'
  readonly mimic: CompiledMimic
}

export type CompiledComposedPanel = ComposedTrendPanel | ComposedComparisonPanel | ComposedReadoutsPanel | ComposedAlarmsPanel | ComposedMimicPanel

/** Every signal a compiled panel shows, in display order. */
export const composedPanelPens = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'alarms' || panel.kind === 'mimic') return []
  return panel.kind === 'trend' ? [...panel.strips.flatMap(strip => strip.pens), ...panel.live] : panel.pens
}

export interface CompiledComposedDisplay {
  readonly plantId: string
  readonly title: string
  /** What an agent composed the display to answer; null for a display World generates itself (the unit overview). */
  readonly advice: { readonly question: string; readonly need: string } | null
  readonly modelDigest: string
  readonly height: number
  readonly panels: ReadonlyArray<CompiledComposedPanel>
}

export interface ComposedDisplayIssue {
  readonly path: string
  readonly message: string
  readonly didYouMean?: ReadonlyArray<string>
}

export type ComposedDisplayCompileResult =
  | { readonly ok: true; readonly display: CompiledComposedDisplay }
  | { readonly ok: false; readonly issues: ReadonlyArray<ComposedDisplayIssue> }


const suggestionsFor = (ref: string, bindings: ReadonlyArray<ProcessSignalBinding>): ReadonlyArray<string> => {
  const guessed = words(ref)
  const target = normalized(ref)
  if (guessed.length === 0) return []
  return bindings
    .map(binding => {
      const keys = [binding.tagId, binding.path].filter((key): key is NonNullable<typeof key> => key !== undefined).map(String)
      const matched = matchedWords(guessed, [...new Set([...keys, binding.label].flatMap(words))])
      const label = words(binding.label)
      const distance = Math.min(...keys.map(key => editDistance(normalized(key), target)))
      return {
        binding,
        // Longer guessed words carry more meaning: in RCS-TAVG, tavg outweighs rcs.
        score: letters(matched) / letters(guessed),
        substantive: matched.some(guess => guess.length >= 2),
        // How much of what the signal is (its label) the guess names: PZR-PRESS is pressurizer pressure, not spray.
        labelCover: label.length === 0 ? 0 : matchedWords(label, guessed).length / label.length,
        distance,
      }
    })
    .filter(entry => entry.substantive && entry.score >= 0.5)
    // Operators name instruments by tag, so tagged signals lead among equal matches.
    .sort((left, right) => right.score - left.score
      || Number(left.binding.tagId === undefined) - Number(right.binding.tagId === undefined)
      || right.labelCover - left.labelCover
      || left.distance - right.distance
      || String(left.binding.path).localeCompare(String(right.binding.path)))
    .slice(0, SUGGESTION_COUNT)
    .map(({ binding }) => `${binding.tagId ?? binding.path} (${binding.label}, ${binding.unit})`)
}

const resolveRef = (system: ProcessPlantRuntimeInstance, ref: string): ProcessSignalBinding | undefined => {
  const tag = processSignalTagIdSchema.safeParse(ref)
  if (tag.success) {
    const binding = findProcessPlantSignalBinding(system.plant.graph, { tagId: tag.data })
    if (binding) return binding
  }
  const path = variablePathSchema.safeParse(ref)
  if (path.success) return findProcessPlantSignalBinding(system.plant.graph, { path: path.data })
  return undefined
}

const zodIssues = (error: z.ZodError): ReadonlyArray<ComposedDisplayIssue> => error.issues.map(issue => ({
  path: issue.path.map(String).join('.') || '(composition)',
  message: issue.message,
}))

// Every displayed signal's thresholds are drawn: an operator must see when any
// of them nears or crosses a limit. Parallel loops share set points, so one
// line per distinct rule action (kind, direction, value, mode) keeps the panel
// readable and names every signal it covers.
const drawnThresholds = (pens: ReadonlyArray<ComposedDisplayPen>): ReadonlyArray<ComposedTrendThreshold> => {
  const byAction = new Map<string, ComposedTrendThreshold>()
  for (const pen of pens) {
    for (const threshold of pen.thresholds) {
      const key = `${threshold.kind}|${threshold.direction}|${threshold.value}|${threshold.modeLabel ?? ''}`
      const signal = pen.tagId ?? String(pen.path)
      const existing = byAction.get(key)
      byAction.set(key, existing === undefined
        ? { ...threshold, ruleIds: [threshold.ruleId], signals: [signal] }
        : {
            ...existing,
            label: existing.label === threshold.label ? existing.label : `${existing.label} · ${threshold.label}`,
            ruleIds: [...existing.ruleIds, threshold.ruleId],
            signals: [...existing.signals, signal],
          })
    }
  }
  return [...byAction.values()].sort((left, right) => left.value - right.value || left.ruleId.localeCompare(right.ruleId))
}

// Parallel equipment shares an equipment class (the four steam generators);
// a pipe's measurements belong to its service (main steam).
const signalIdentity = (
  system: ProcessPlantRuntimeInstance,
  binding: ProcessSignalBinding,
): { readonly name: string; readonly measurement: string } => {
  const variable = String(binding.path).slice(String(binding.path).indexOf('.') + 1)
  if (binding.owner.type === 'link') {
    const link = system.plant.graph.links[binding.owner.linkIndex]!
    return { name: binding.tagId ?? binding.label, measurement: `link:${link.service ?? link.kind}.${variable}|${binding.unit}` }
  }
  const component = system.plant.graph.components[binding.owner.componentIndex]!
  const named = binding.label.toLowerCase().includes(component.label.toLowerCase()) ? binding.label : `${binding.label} · ${component.label}`
  return {
    name: binding.tagId ?? named,
    measurement: `${component.metadata?.equipmentClass ?? component.kind}.${variable}|${binding.unit}`,
  }
}

const resolvePens = (
  system: ProcessPlantRuntimeInstance,
  signals: ReadonlyArray<ComposedDisplaySignal>,
  panelPath: string,
  options: { readonly numericOnly: boolean; readonly panelName: string; readonly recordedSeriesIds: ReadonlySet<string> },
  issues: ComposedDisplayIssue[],
): ReadonlyArray<ComposedDisplayPen> | undefined => {
  const pens: ComposedDisplayPen[] = []
  const seen = new Set<VariablePath>()
  signals.forEach((signal, signalIndex) => {
    const path = `${panelPath}.signals.${signalIndex}.ref`
    const binding = resolveRef(system, signal.ref)
    if (!binding) {
      const didYouMean = suggestionsFor(signal.ref, system.plant.graph.signalBindings)
      issues.push({
        path,
        message: `unknown signal "${signal.ref}"; use an exact tagId or variable path from your evidence or world.process-plant.signals.search`,
        ...(didYouMean.length === 0 ? {} : { didYouMean }),
      })
      return
    }
    if (seen.has(binding.path)) {
      issues.push({ path, message: `"${signal.ref}" repeats a signal already in this ${options.panelName}` })
      return
    }
    seen.add(binding.path)
    const value = system.runtime.readVariableSnapshot(binding.path).value
    if (typeof value !== 'number' && (options.numericOnly || typeof value !== 'boolean')) {
      issues.push({ path, message: `"${signal.ref}" is a ${typeof value} state signal; ${options.panelName} panels show numeric signals only (use a readouts panel for states)` })
      return
    }
    const { thresholds, combinedRules } = icThresholdsForSignal(system.plant, binding.path)
    const seriesId = recordingSeriesIdFor(system.plant.id, binding.path)
    const identity = signalIdentity(system, binding)
    pens.push({
      ref: signal.ref,
      role: signal.role,
      path: binding.path,
      ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
      label: binding.label,
      name: identity.name,
      measurement: identity.measurement,
      unit: binding.unit,
      quantity: binding.quantity,
      valueKind: typeof value === 'number' ? 'number' : 'boolean',
      seriesId,
      recorded: options.recordedSeriesIds.has(seriesId),
      command: binding.writable,
      ...(binding.limits === undefined ? {} : { limits: binding.limits }),
      thresholds,
      combinedRules,
    })
  })
  return pens.length === signals.length ? pens : undefined
}

const unitGroups = (pens: ReadonlyArray<ComposedDisplayPen>): string => [...new Set(pens.map(pen => pen.unit))]
  .map(unit => `[${unit}] ${pens.filter(pen => pen.unit === unit).map(pen => pen.ref).join(', ')}`).join('; ')

const stripGroups = (strips: ReadonlyArray<ComposedTrendStrip>): string => strips
  .map(strip => `[${strip.pens[0]!.label}, ${strip.unit}] ${strip.pens.map(pen => pen.ref).join(', ')}`).join('; ')

const sharedUnit = (
  pens: ReadonlyArray<ComposedDisplayPen>,
  panelPath: string,
  issues: ComposedDisplayIssue[],
): ProcessUnit | undefined => {
  const units = [...new Set(pens.map(pen => pen.unit))]
  if (units.length === 1) return units[0]
  issues.push({
    path: `${panelPath}.signals`,
    message: `a comparison shares one value axis, but these signals use ${units.length} units: ${unitGroups(pens)}; keep the primary signal's unit here and trend the others`,
  })
  return undefined
}

// The Pack, not the author, decides how trended signals share axes. Only the
// same measurement of parallel equipment shares one (the four SG levels);
// pressurizer and SG pressure, or core outlet temperature and subcooling
// margin, get their own strips so neither is flattened by the other's range
// and no strip shows another signal's limits. The strip holding a primary
// signal comes first, then request order.
const trendStrips = (pens: ReadonlyArray<ComposedDisplayPen>): ReadonlyArray<ComposedTrendStrip> => {
  const measurements = [...new Set(pens.map(pen => pen.measurement))]
  const hasPrimary = (measurement: string): boolean => pens.some(pen => pen.measurement === measurement && pen.role === 'primary')
  return [...measurements.filter(hasPrimary), ...measurements.filter(measurement => !hasPrimary(measurement))].map(measurement => {
    const stripPens = pens.filter(pen => pen.measurement === measurement)
    return { unit: stripPens[0]!.unit, pens: stripPens, thresholds: drawnThresholds(stripPens) }
  })
}

/** A compiled panel before the display is fitted: trends have no plot height yet. */
type UnsizedPanel = Exclude<CompiledComposedPanel, ComposedTrendPanel> | Omit<ComposedTrendPanel, 'plot'>

const compilePanel = (
  system: ProcessPlantRuntimeInstance,
  panel: ComposedDisplayPanel,
  panelIndex: number,
  recordedSeriesIds: ReadonlySet<string>,
  issues: ComposedDisplayIssue[],
): UnsizedPanel | undefined => {
  const panelPath = `panels.${panelIndex}`
  if (panel.kind === 'alarms') return { kind: 'alarms', scope: panel.scope, ruleIds: [] }
  if (panel.kind === 'mimic') throw new Error('a mimic is compiled once the other panels are known')
  if (panel.kind === 'readouts') {
    const pens = resolvePens(system, panel.signals, panelPath, { numericOnly: false, panelName: 'readouts', recordedSeriesIds }, issues)
    return pens === undefined ? undefined : { kind: 'readouts', pens }
  }
  const pens = resolvePens(system, panel.signals, panelPath, { numericOnly: true, panelName: panel.kind, recordedSeriesIds }, issues)
  if (pens === undefined) return undefined
  if (panel.kind === 'trend') {
    return {
      kind: 'trend',
      horizon: panel.horizon,
      horizonMs: composedDisplayHorizonMs[panel.horizon],
      strips: trendStrips(pens.filter(pen => pen.recorded)),
      live: pens.filter(pen => !pen.recorded),
    }
  }
  const unit = sharedUnit(pens, panelPath, issues)
  if (unit === undefined) return undefined
  return { kind: 'comparison', unit, pens, thresholds: drawnThresholds(pens) }
}

const panelShape = (panel: UnsizedPanel): ComposedPanelShape => {
  if (panel.kind === 'trend') return { kind: 'trend', strips: panel.strips.map(strip => strip.pens.length), live: panel.live.length }
  if (panel.kind === 'comparison') return { kind: 'comparison', rows: panel.pens.length }
  if (panel.kind === 'readouts') return { kind: 'readouts', values: panel.pens.length }
  if (panel.kind === 'mimic') return { kind: 'mimic', height: panel.mimic.height }
  return { kind: 'alarms' }
}

const compositionIssues = (composition: ComposedDisplayComposition): ReadonlyArray<ComposedDisplayIssue> => {
  const issues: ComposedDisplayIssue[] = []
  const kinds = composition.panels.map(panel => panel.kind)
  if (kinds.filter(kind => kind === 'trend').length > COMPOSED_DISPLAY_MAX_TRENDS) {
    issues.push({ path: 'panels', message: 'use one trend panel and list every signal whose history matters in it; the display stacks one strip per measurement on a shared time axis' })
  }
  composition.panels.forEach((panel, index) => {
    if (panel.kind === 'trend' && panel.signals.length > COMPOSED_TREND_MAX_SIGNALS) {
      issues.push({ path: `panels.${index}.signals`, message: `a trend shows at most ${COMPOSED_TREND_MAX_SIGNALS} signals, but this one lists ${panel.signals.length}; keep the ones the question is about` })
    }
  })
  for (const kind of ['comparison', 'readouts', 'alarms', 'mimic'] as const) {
    if (kinds.filter(candidate => candidate === kind).length > 1) issues.push({ path: 'panels', message: `use at most one ${kind} panel` })
  }
  if (kinds.every(kind => kind === 'alarms')) issues.push({ path: 'panels', message: 'an alarms panel accompanies signal panels; add a trend, comparison, readouts or mimic panel' })
  const signals = composition.panels.flatMap(panel => panel.kind === 'alarms' || panel.kind === 'mimic' ? [] : panel.signals)
  // A mimic alone answers an equipment question and names no signals.
  if (signals.length > 0 && !signals.some(signal => signal.role === 'primary')) issues.push({ path: 'panels', message: 'mark at least one signal with role "primary": the signal the operator question is about' })
  // A signal repeated in a second panel of the same kind, or as a readout of a
  // trended signal (whose legend already carries its value), adds height but
  // no evidence. A comparison (now, across loops) and a trend (history) of the
  // same signal answer different questions and may both show it.
  const redundantPair = (first: ComposedDisplayPanel['kind'], second: ComposedDisplayPanel['kind']): boolean =>
    first === second || (first === 'trend' && second === 'readouts') || (first === 'readouts' && second === 'trend')
  const shownIn = new Map<string, Array<{ readonly index: number; readonly kind: ComposedDisplayPanel['kind'] }>>()
  composition.panels.forEach((panel, panelIndex) => {
    if (panel.kind === 'alarms' || panel.kind === 'mimic') return
    for (const signal of panel.signals) {
      const earlier = shownIn.get(signal.ref) ?? []
      const clash = earlier.find(entry => entry.index !== panelIndex && redundantPair(entry.kind, panel.kind))
      if (clash !== undefined) {
        issues.push({ path: `panels.${panelIndex}.signals`, message: `"${signal.ref}" is already shown in panels.${clash.index} (${clash.kind}); a ${panel.kind} adds nothing for it, so remove it here` })
      }
      shownIn.set(signal.ref, [...earlier, { index: panelIndex, kind: panel.kind }])
    }
  })
  return issues
}

// Strip and size limits need resolved units, so they are checked after compiling.
const layoutIssues = (
  panels: ReadonlyArray<CompiledComposedPanel>,
  fit: { readonly height: number; readonly panels: ReadonlyArray<ComposedPanelSize> },
): ReadonlyArray<ComposedDisplayIssue> => {
  const issues: ComposedDisplayIssue[] = []
  panels.forEach((panel, index) => {
    if (panel.kind !== 'trend') return
    const pens = composedPanelPens(panel)
    if (panel.strips.length === 0) {
      issues.push({ path: `panels.${index}.signals`, message: `none of ${pens.map(pen => pen.ref).join(', ')} is recorded by this Run's historian, so the trend would have no history; show them in a readouts panel, or trend tagged instruments` })
    }
    if (panel.strips.length > COMPOSED_TREND_MAX_STRIPS) {
      issues.push({ path: `panels.${index}.signals`, message: `a trend stacks at most ${COMPOSED_TREND_MAX_STRIPS} strips, one per measurement (parallel equipment shares one), but these signals are ${panel.strips.length} measurements: ${stripGroups(panel.strips)}; drop the measurement that answers least of the question` })
    }
    for (const strip of panel.strips.filter(candidate => candidate.pens.length > COMPOSED_TREND_STRIP_MAX_PENS)) {
      issues.push({ path: `panels.${index}.signals`, message: `a trend strip shows at most ${COMPOSED_TREND_STRIP_MAX_PENS} parallel signals, but [${strip.pens[0]!.label}, ${strip.unit}] has ${strip.pens.length}: ${strip.pens.map(pen => pen.ref).join(', ')}; keep the most telling ones, or compare the loops in a comparison panel` })
    }
  })
  const sampled = new Set(panels.flatMap(panel => panel.kind === 'mimic' ? panel.mimic.paths : composedPanelPens(panel).map(pen => pen.path)))
  if (sampled.size > COMPOSED_DISPLAY_MAX_SAMPLE_PATHS) {
    issues.push({ path: 'panels', message: `the display would read ${sampled.size} live values, more than the ${COMPOSED_DISPLAY_MAX_SAMPLE_PATHS} a chat view samples; draw fewer loops in the mimic or show fewer signals` })
  }
  const maxHeight = composedDisplayMaxHeight(panels)
  if (fit.height > maxHeight) {
    const parts = fit.panels.map((size, index) => `panels.${index} ${size.kind}${size.kind === 'trend' && size.strips.length > 1 ? ` (${size.strips.length} strips)` : ''} ${composedPanelHeight(size)} px`).join(', ')
    const shrunk = fit.panels.some(size => size.kind === 'trend') ? ' even with its trend at the smallest height' : ''
    const fixes = sizeFixes(panels)
    issues.push({
      path: 'panels',
      message: `the display needs ${fit.height} px${shrunk}, but chat views allow ${maxHeight} (${parts}); ${fixes.length === 0 ? 'drop the panel or trend measurement that answers least of the question' : `it fits ${fixes.join(', or ')}`}`,
    })
  }
  return issues
}

const fits = (panels: ReadonlyArray<UnsizedPanel>): boolean =>
  panels.length > 0 && fitComposedDisplay(panels.map(panelShape)).height <= composedDisplayMaxHeight(panels)

// Concrete ways to fit, so the next compose succeeds: dropping one supporting
// panel, keeping fewer readouts, or trending fewer measurements.
const sizeFixes = (panels: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<string> => {
  const fixes: string[] = []
  panels.forEach((panel, index) => {
    if (panel.kind === 'readouts') {
      const kept = [6, 5, 4, 3, 2, 1].filter(count => count < panel.pens.length)
        .find(count => fits(panels.map((candidate, at) => at === index ? { ...panel, pens: panel.pens.slice(0, count) } : candidate)))
      if (kept !== undefined) fixes.push(`with at most ${kept} readouts in panels.${index}`)
    }
    if (panel.kind === 'trend' && panel.strips.length > 1) {
      const kept = [3, 2, 1].filter(count => count < panel.strips.length)
        .find(count => fits(panels.map((candidate, at) => at === index ? { ...panel, strips: panel.strips.slice(0, count) } : candidate)))
      if (kept !== undefined) fixes.push(`with at most ${kept} trend measurements (strips)`)
    }
    if (panel.kind !== 'trend' && fits(panels.filter((_, at) => at !== index))) fixes.push(`without panels.${index} (${panel.kind})`)
  })
  return fixes
}

// Alarms "related" to a display are those whose rules act on its signals or
// on other signals of the same equipment.
const relatedRuleIds = (system: ProcessPlantRuntimeInstance, panels: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<string> => {
  const pens = panels.flatMap(composedPanelPens)
  return [...new Set([
    ...pens.flatMap(pen => [
      ...pen.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.ruleId),
      ...pen.combinedRules.filter(rule => rule.kind !== 'control').map(rule => rule.ruleId),
    ]),
    ...icAlarmRuleIdsForEquipment(system.plant, pens.map(pen => pen.path)),
    ...panels.flatMap(panel => panel.kind === 'mimic' ? panel.mimic.items.flatMap(item => item.binding.frames.map(frame => frame.ruleId)) : []),
  ])].sort()
}

// The panels whose removal lets a drawing fit as asked: each one alone, or else all of them.
const fewerPanels = (besides: ReadonlyArray<number>, fits: (kept: ReadonlyArray<number>) => boolean): ReadonlyArray<ReadonlyArray<number>> => {
  if (besides.length === 0) return []
  const singles = besides.filter(removed => fits(besides.filter(other => other !== removed))).map(removed => [removed])
  if (singles.length > 0) return singles
  return besides.length > 1 && fits([]) ? [besides] : []
}

/**
 * `compose` applies the authoring rules (panel counts, strips, size budget,
 * one panel per signal, a primary signal) that keep new displays lean. `view` re-opens a
 * display already shown in a conversation: it checks only what rendering
 * needs, so a later authoring rule never breaks earlier advice.
 */
export const compileComposedDisplay = (
  system: ProcessPlantRuntimeInstance,
  input: unknown,
  purpose: 'compose' | 'view',
  /** Series this Run's historian records; trends of other signals start when the view opens. */
  recordedSeriesIds: ReadonlySet<string>,
): ComposedDisplayCompileResult => {
  const parsed = composedDisplayCompositionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const composition = parsed.data
  // Authoring issues are reported with the resolution and layout issues, so a
  // single rejection lists every fix; layout needs resolved signals, so it is
  // checked only once every reference resolves.
  const authoring = purpose === 'compose' ? compositionIssues(composition) : []
  const issues: ComposedDisplayIssue[] = []
  if (composition.plantId !== system.plant.id) {
    issues.push({ path: 'plantId', message: `composition targets ${composition.plantId}, not ${system.plant.id}` })
  }
  const others = composition.panels.map((panel, index) => panel.kind === 'mimic' ? undefined : compilePanel(system, panel, index, recordedSeriesIds, issues))
  // The mimic draws in the room the other panels leave at their smallest.
  const heights = others.map(panel => panel === undefined ? 0 : composedPanelMinimumHeight(panelShape(panel)) + composedDisplayLayout.panelGap)
  const mimicBudget = (left: ReadonlyArray<number>) => ({
    profile: chatMimicProfile,
    maxWidth: MIMIC_MAX_WIDTH,
    maxHeight: COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX - composedDisplayLayout.frame - composedDisplayLayout.mimicLegend - left.reduce((sum, index) => sum + heights[index]!, 0),
  })
  const besides = others.flatMap((panel, index) => panel === undefined ? [] : [index])
  const panels = composition.panels.map((panel, index): UnsizedPanel | undefined => {
    if (panel.kind !== 'mimic') return others[index]
    const { kind: _kind, ...intent } = panel
    const compiled = compileMimic(system.plant, intent, mimicBudget(besides))
    if (!compiled.ok) {
      // A drawing refused for its size may fit as asked beside fewer panels.
      const roomier = compiled.issues.some(issue => issue.field === '(mimic)') ? fewerPanels(besides, kept => compileMimic(system.plant, intent, mimicBudget(kept)).ok) : []
      const without = roomier.map(removed => removed.map(other => `panels.${other} (${composition.panels[other]!.kind})`).join(' and '))
      for (const issue of compiled.issues) {
        const message = issue.field === '(mimic)' && without.length > 0 ? `${issue.message}; or it fits as asked without ${without.join(', or without ')}` : issue.message
        issues.push({ path: `panels.${index}${issue.field === '(mimic)' ? '' : `.${issue.field}`}`, message, ...(issue.didYouMean === undefined ? {} : { didYouMean: issue.didYouMean }) })
      }
      return undefined
    }
    return { kind: 'mimic', mimic: compiled.mimic }
  })
  if (issues.length > 0) return { ok: false, issues: [...authoring, ...issues] }
  const unsized = panels.filter((panel): panel is UnsizedPanel => panel !== undefined)
  const fit = fitComposedDisplay(unsized.map(panelShape))
  const compiled = unsized.map((panel, index): CompiledComposedPanel => {
    if (panel.kind !== 'trend') return panel
    const size = fit.panels[index]
    if (size?.kind !== 'trend') throw new Error('fitted panels follow the compiled panels')
    return { ...panel, plot: size.plot }
  })
  const layout = purpose === 'compose' ? layoutIssues(compiled, fit) : []
  if (authoring.length > 0 || layout.length > 0) return { ok: false, issues: [...authoring, ...layout] }
  const ruleIds = relatedRuleIds(system, compiled)
  return {
    ok: true,
    display: {
      plantId: system.plant.id,
      title: composition.title,
      advice: { question: composition.question, need: composition.need },
      modelDigest: system.plant.modelDigest,
      height: fit.height,
      panels: compiled.map(panel => panel.kind === 'alarms' ? { ...panel, ruleIds } : panel),
    },
  }
}

/** The largest screen a unit overview is drawn for at 1:1; a larger drawing is refused with the size it needs. */
export const UNIT_OVERVIEW_CANVAS = { maxWidth: 2560, maxHeight: 1440 } as const

/**
 * The unit overview World generates for a Plant: its lead values (protection
 * and energy, overview-key-values.ts), its principal circuits drawn by the
 * overview profile (principal.ts), and the whole Plant's active alarms. Every
 * part comes from the model; nothing names equipment.
 */
export const compileOverviewDisplay = (system: ProcessPlantRuntimeInstance, recordedSeriesIds: ReadonlySet<string>): ComposedDisplayCompileResult => {
  const issues: ComposedDisplayIssue[] = []
  const keyValues = overviewKeyValues(system.plant)
  const readouts = keyValues.length === 0 ? undefined
    : compilePanel(system, { kind: 'readouts', signals: keyValues.map(path => ({ ref: path, role: 'primary' as const })) }, 0, recordedSeriesIds, issues)
  const circuits = principalCircuits(system.plant.graph)
  if (!circuits.ok) return { ok: false, issues: [{ path: 'overview', message: circuits.reason }] }
  const drawn = compileMimicScope(system.plant, circuits.scope, { profile: overviewMimicProfile, ...UNIT_OVERVIEW_CANVAS })
  if (!drawn.ok) return { ok: false, issues: drawn.issues.map(issue => ({ path: 'overview', message: issue.message })) }
  if (issues.length > 0) return { ok: false, issues }
  const unsized: ReadonlyArray<UnsizedPanel> = [
    ...(readouts === undefined ? [] : [readouts]),
    { kind: 'mimic', mimic: drawn.mimic },
    { kind: 'alarms', scope: 'plant', ruleIds: [] },
  ]
  // Nothing in an overview is a trend, so every panel has its natural height.
  const panels = unsized.map((panel): CompiledComposedPanel => {
    if (panel.kind === 'trend') throw new Error('a unit overview has no trend')
    return panel
  })
  return {
    ok: true,
    display: {
      plantId: system.plant.id,
      title: 'Unit overview',
      advice: null,
      modelDigest: system.plant.modelDigest,
      height: fitComposedDisplay(unsized.map(panelShape)).height,
      panels,
    },
  }
}

const operatorText = { '<': 'below', '<=': 'at or below', '>': 'above', '>=': 'at or above' } as const
const signalName = (pen: ComposedDisplayPen): string => `${pen.name} (${pen.tagId === undefined ? `${pen.path}, ` : `${pen.label}, `}${pen.unit}, ${pen.role}${pen.command ? ', a command (demand), shown as demand' : ''})`

// Lines are named as the display labels them ("LO ALM 30 %"), so an answer
// can refer to them by the same name.
const thresholdText = (threshold: ComposedTrendThreshold, unit: ProcessUnit): string =>
  `${threshold.kind === 'control' ? `I&C control set point marked on the axis: ${threshold.label}` : `"${thresholdName(threshold, unit)}" ${threshold.kind} line: ${threshold.label}`}, acts ${operatorText[threshold.operator]} ${threshold.value} ${unit} for ${threshold.signals.join(', ')}${threshold.modeLabel === undefined ? '' : ` (only in ${threshold.modeLabel})`}`

/** How each requested reference resolved, so the agent learns exact tags, paths and units. */
export const composedDisplaySignals = (display: CompiledComposedDisplay): ReadonlyArray<{
  readonly ref: string
  readonly tagId?: string
  readonly path: string
  readonly label: string
  readonly name: string
  readonly unit: string
}> => display.panels.flatMap(panel => composedPanelPens(panel).map(pen => ({
  ref: pen.ref,
  ...(pen.tagId === undefined ? {} : { tagId: pen.tagId }),
  path: String(pen.path),
  label: pen.label,
  name: pen.name,
  unit: pen.unit,
})))

const mimicShows = (mimic: CompiledMimic): ReadonlyArray<string> => [
  `Live equipment mimic generated from the Plant model (${mimic.summary.carriers.join(', ')}): ${mimic.summary.equipment.map(item => `${item.label} (${item.id})`).join(', ')}. Pumps are drawn running or stopped from their actual speed, valves from their actual position, levels as vessel fills; pipes show flow, no flow (hollow) or unknown (dashed), with a direction arrow only where the model computes the direction; a command that disagrees with the equipment is stated as "CMD …"; equipment with an active alarm is framed with what the alarm watches ("P LO-LO")`,
  ...(mimic.summary.stops.length === 0 ? [] : [`The drawing stops at: ${mimic.summary.stops.join('; ')}`]),
]

/** Plain statements of what the view shows, so the agent's text need not repeat it. */
export const composedDisplayShows = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => {
  if (panel.kind === 'trend') {
    const strips = panel.strips.length === 1 ? '' : ` in ${panel.strips.length} stacked strips (one per measurement)`
    return [
      ...(panel.strips.length === 0 ? [] : [`Live trend of the last ${panel.horizon}${strips}: ${panel.strips.flatMap(strip => strip.pens).map(signalName).join('; ')}`]),
      ...(panel.live.length === 0 ? [] : [`Current values only, not recorded by this Run (no history to describe): ${panel.live.map(signalName).join('; ')}`]),
      ...panel.strips.flatMap(strip => strip.thresholds.map(threshold => thresholdText(threshold, strip.unit))),
    ]
  }
  if (panel.kind === 'comparison') return [`Live side-by-side comparison with the median: ${panel.pens.map(signalName).join('; ')}`, ...panel.thresholds.map(threshold => thresholdText(threshold, panel.unit))]
  if (panel.kind === 'readouts') return [`Live readouts with margin to the nearest I&C alarm or trip threshold: ${panel.pens.map(signalName).join('; ')}`]
  if (panel.kind === 'mimic') return mimicShows(panel.mimic)
  return [panel.scope === 'related' ? `Active alarms and trips of the ${panel.ruleIds.length} I&C rules acting on the displayed signals and their equipment` : 'All active alarms and trips of the Plant']
})

/**
 * Each displayed numeric signal's nearest alarm or trip limit now, worded as
 * the display words it, nearest first relative to the limit. The answer's
 * "what to watch" should start from these, not from a limit the signal is
 * moving away from.
 */
export const composedDisplayMargins = (
  display: CompiledComposedDisplay,
  read: (path: VariablePath) => unknown,
): ReadonlyArray<string> => {
  const pens = [...new Map(display.panels.flatMap(composedPanelPens).map(pen => [pen.path, pen])).values()]
  return pens
    .flatMap(pen => {
      const value = read(pen.path)
      if (typeof value !== 'number') return []
      const margin = nearestThresholdMargin(value, pen.thresholds)
      if (margin === null) return []
      const relative = margin.margin / Math.max(Math.abs(margin.threshold.value), Number.EPSILON)
      return [{ relative, text: `${pen.name}: ${formatQuantity(value, pen.unit)}, ${marginText(margin, pen.unit)}` }]
    })
    .sort((left, right) => left.relative - right.relative)
    .map(entry => entry.text)
}

export const composedDisplayWarnings = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => {
  if (panel.kind === 'alarms') return panel.scope === 'related' && panel.ruleIds.length === 0 ? ['No alarm or trip rule acts on the displayed signals; the related alarms panel will stay empty.'] : []
  if (panel.kind === 'mimic') {
    return [
      ...panel.mimic.summary.unverifiedFlows.map(link => `The Plant model does not verify the flow in ${link}; the mimic draws it as unknown, so say nothing about that flow.`),
      ...panel.mimic.summary.unmeasuredStates.map(label => `The Plant model does not compute the position of ${label}; the mimic judges it by the flow through it ("POS ?").`),
    ]
  }
  return composedPanelPens(panel).flatMap(pen => [
    ...(pen.command ? [`${pen.name} is a writable command (a demand), not a measured state; never present it as the equipment's actual state or position.`] : []),
    ...(panel.kind === 'trend' && pen.role === 'primary' && pen.thresholds.length === 0 ? [`No single-signal I&C threshold acts on ${pen.tagId ?? pen.path}; its trend shows values without threshold lines.`] : []),
    ...(panel.kind === 'trend' && !pen.recorded ? [`${pen.tagId ?? pen.path} is not recorded by this Run's historian; its trend starts when the view opens. Do not describe its history from the display.`] : []),
    ...pen.combinedRules.map(rule => `${pen.tagId ?? pen.path} also feeds the combined rule "${rule.label}" (${rule.kind}); it is listed, not drawn.`),
  ])
})

/** Why a display already shown in a conversation can no longer be drawn. */
export const formatComposedViewIssues = (issues: ReadonlyArray<ComposedDisplayIssue>): string =>
  `This display can no longer be shown for the current Plant model: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`

export const formatComposedDisplayIssues = (issues: ReadonlyArray<ComposedDisplayIssue>): string => [
  `Display composition rejected (${issues.length} issue${issues.length === 1 ? '' : 's'}); nothing will be shown. Fix every issue and call world.process-plant.display.compose again:`,
  ...issues.map(issue => `- ${issue.path}: ${issue.message}${issue.didYouMean === undefined ? '' : `. Did you mean: ${issue.didYouMean.join('; ')}`}`),
].join('\n')
