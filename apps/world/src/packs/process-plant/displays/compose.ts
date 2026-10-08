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
  COMPOSED_DISPLAY_MAX_TRENDS,
  composedDisplayCompositionSchema,
  composedDisplayHeight,
  composedPanelHeight,
  composedDisplayHorizonMs,
  type ComposedDisplayComposition,
  type ComposedDisplayHorizon,
  type ComposedDisplayPanel,
  type ComposedDisplaySignal,
  type ComposedDisplaySignalRole,
} from './composition.ts'
import {
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
  readonly unit: ProcessUnit
  readonly quantity: ProcessQuantity
  readonly valueKind: 'number' | 'boolean'
  readonly seriesId: string
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

export interface ComposedTrendPanel {
  readonly kind: 'trend'
  readonly horizon: ComposedDisplayHorizon
  readonly horizonMs: number
  readonly unit: ProcessUnit
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  readonly thresholds: ReadonlyArray<ComposedTrendThreshold>
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

export type CompiledComposedPanel = ComposedTrendPanel | ComposedComparisonPanel | ComposedReadoutsPanel | ComposedAlarmsPanel

export interface CompiledComposedDisplay {
  readonly plantId: string
  readonly title: string
  readonly question: string
  readonly need: string
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

const normalized = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]!
    previous[0] = i
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]!
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[right.length]!
}

// Suggestions help the model correct a near miss; they never select a signal.
const SUGGESTION_COUNT = 3

const suggestionsFor = (ref: string, bindings: ReadonlyArray<ProcessSignalBinding>): ReadonlyArray<string> => {
  const target = normalized(ref)
  if (target.length === 0) return []
  return bindings
    .map(binding => {
      const keys = [binding.tagId, binding.path].filter((key): key is NonNullable<typeof key> => key !== undefined).map(String)
      const distance = Math.min(...keys.map(key => {
        const candidate = normalized(key)
        if (candidate.includes(target) || target.includes(candidate)) return Math.abs(candidate.length - target.length) / 2
        return editDistance(candidate, target)
      }))
      return { binding, distance }
    })
    .filter(entry => entry.distance <= Math.max(2, Math.floor(target.length / 3)))
    .sort((left, right) => left.distance - right.distance || String(left.binding.path).localeCompare(String(right.binding.path)))
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

const resolvePens = (
  system: ProcessPlantRuntimeInstance,
  signals: ReadonlyArray<ComposedDisplaySignal>,
  panelPath: string,
  options: { readonly numericOnly: boolean; readonly panelName: string },
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
    pens.push({
      ref: signal.ref,
      role: signal.role,
      path: binding.path,
      ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
      label: binding.label,
      unit: binding.unit,
      quantity: binding.quantity,
      valueKind: typeof value === 'number' ? 'number' : 'boolean',
      seriesId: recordingSeriesIdFor(system.plant.id, binding.path),
      ...(binding.limits === undefined ? {} : { limits: binding.limits }),
      thresholds,
      combinedRules,
    })
  })
  return pens.length === signals.length ? pens : undefined
}

const sharedUnit = (
  pens: ReadonlyArray<ComposedDisplayPen>,
  panelPath: string,
  panelName: string,
  issues: ComposedDisplayIssue[],
): ProcessUnit | undefined => {
  const units = [...new Set(pens.map(pen => pen.unit))]
  if (units.length === 1) return units[0]
  const groups = units.map(unit => `[${unit}] ${pens.filter(pen => pen.unit === unit).map(pen => pen.ref).join(', ')}`).join('; ')
  issues.push({
    path: `${panelPath}.signals`,
    message: `a ${panelName} shares one value axis, but these signals use ${units.length} units: ${groups}; keep the primary signal's unit here and move or drop the others (at most two stacked trends per display)`,
  })
  return undefined
}

const compilePanel = (
  system: ProcessPlantRuntimeInstance,
  panel: ComposedDisplayPanel,
  panelIndex: number,
  issues: ComposedDisplayIssue[],
): CompiledComposedPanel | undefined => {
  const panelPath = `panels.${panelIndex}`
  if (panel.kind === 'alarms') return { kind: 'alarms', scope: panel.scope, ruleIds: [] }
  if (panel.kind === 'readouts') {
    const pens = resolvePens(system, panel.signals, panelPath, { numericOnly: false, panelName: 'readouts' }, issues)
    return pens === undefined ? undefined : { kind: 'readouts', pens }
  }
  const panelName = panel.kind === 'trend' ? 'trend' : 'comparison'
  const pens = resolvePens(system, panel.signals, panelPath, { numericOnly: true, panelName }, issues)
  if (pens === undefined) return undefined
  const unit = sharedUnit(pens, panelPath, panelName, issues)
  if (unit === undefined) return undefined
  if (panel.kind === 'comparison') return { kind: 'comparison', unit, pens, thresholds: drawnThresholds(pens) }
  return { kind: 'trend', horizon: panel.horizon, horizonMs: composedDisplayHorizonMs[panel.horizon], unit, pens, thresholds: drawnThresholds(pens) }
}

const compositionIssues = (composition: ComposedDisplayComposition): ReadonlyArray<ComposedDisplayIssue> => {
  const issues: ComposedDisplayIssue[] = []
  const kinds = composition.panels.map(panel => panel.kind)
  const trends = composition.panels.filter(panel => panel.kind === 'trend')
  if (trends.length > COMPOSED_DISPLAY_MAX_TRENDS) issues.push({ path: 'panels', message: `use at most ${COMPOSED_DISPLAY_MAX_TRENDS} trend panels; keep the signals that answer the question and drop the rest` })
  if (new Set(trends.map(trend => trend.horizon)).size > 1) issues.push({ path: 'panels', message: 'stacked trend panels share one time axis; give them the same horizon' })
  for (const kind of ['comparison', 'readouts', 'alarms'] as const) {
    if (kinds.filter(candidate => candidate === kind).length > 1) issues.push({ path: 'panels', message: `use at most one ${kind} panel` })
  }
  if (kinds.every(kind => kind === 'alarms')) issues.push({ path: 'panels', message: 'an alarms panel accompanies signal panels; add a trend, comparison or readouts panel' })
  const signals = composition.panels.flatMap(panel => panel.kind === 'alarms' ? [] : panel.signals)
  if (!signals.some(signal => signal.role === 'primary')) issues.push({ path: 'panels', message: 'mark at least one signal with role "primary": the signal the operator question is about' })
  // A signal repeated in a second panel of the same kind, or as a readout of a
  // trended signal (whose legend already carries its value), adds height but
  // no evidence. A comparison (now, across loops) and a trend (history) of the
  // same signal answer different questions and may both show it.
  const redundantPair = (first: ComposedDisplayPanel['kind'], second: ComposedDisplayPanel['kind']): boolean =>
    first === second || (first === 'trend' && second === 'readouts') || (first === 'readouts' && second === 'trend')
  const shownIn = new Map<string, Array<{ readonly index: number; readonly kind: ComposedDisplayPanel['kind'] }>>()
  composition.panels.forEach((panel, panelIndex) => {
    if (panel.kind === 'alarms') return
    for (const signal of panel.signals) {
      const earlier = shownIn.get(signal.ref) ?? []
      const clash = earlier.find(entry => entry.index !== panelIndex && redundantPair(entry.kind, panel.kind))
      if (clash !== undefined) {
        issues.push({ path: `panels.${panelIndex}.signals`, message: `"${signal.ref}" is already shown in panels.${clash.index} (${clash.kind}); a ${panel.kind} adds nothing for it, so remove it here` })
      }
      shownIn.set(signal.ref, [...earlier, { index: panelIndex, kind: panel.kind }])
    }
  })
  const height = composedDisplayHeight(composition)
  if (height > COMPOSED_DISPLAY_MAX_HEIGHT_PX) {
    const parts = composition.panels.map((panel, index) => `panels.${index} ${panel.kind} ${composedPanelHeight(panel)} px`).join(', ')
    issues.push({ path: 'panels', message: `the display needs ${height} px but chat views allow ${COMPOSED_DISPLAY_MAX_HEIGHT_PX} (${parts}); drop the panel that answers least of the question` })
  }
  return issues
}

// Alarms "related" to a display are those whose rules act on its signals.
const relatedRuleIds = (panels: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<string> => [...new Set(panels.flatMap(panel =>
  panel.kind === 'alarms' ? [] : panel.pens.flatMap(pen => [
    ...pen.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.ruleId),
    ...pen.combinedRules.filter(rule => rule.kind !== 'control').map(rule => rule.ruleId),
  ])))].sort()

/**
 * `compose` applies the authoring rules (panel counts, size budget, one panel
 * per signal, a primary signal) that keep new displays lean. `view` re-opens a
 * display already shown in a conversation: it checks only what rendering
 * needs, so a later authoring rule never breaks earlier advice.
 */
export const compileComposedDisplay = (
  system: ProcessPlantRuntimeInstance,
  input: unknown,
  purpose: 'compose' | 'view',
): ComposedDisplayCompileResult => {
  const parsed = composedDisplayCompositionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const composition = parsed.data
  const issues: ComposedDisplayIssue[] = purpose === 'compose' ? [...compositionIssues(composition)] : []
  if (composition.plantId !== system.plant.id) {
    issues.push({ path: 'plantId', message: `composition targets ${composition.plantId}, not ${system.plant.id}` })
  }
  const panels = composition.panels.map((panel, index) => compilePanel(system, panel, index, issues))
  if (issues.length > 0) return { ok: false, issues }
  const compiled = panels.filter((panel): panel is CompiledComposedPanel => panel !== undefined)
  const ruleIds = relatedRuleIds(compiled)
  return {
    ok: true,
    display: {
      plantId: system.plant.id,
      title: composition.title,
      question: composition.question,
      need: composition.need,
      modelDigest: system.plant.modelDigest,
      height: composedDisplayHeight(composition),
      panels: compiled.map(panel => panel.kind === 'alarms' ? { ...panel, ruleIds } : panel),
    },
  }
}

const operatorText = { '<': 'below', '<=': 'at or below', '>': 'above', '>=': 'at or above' } as const
const signalName = (pen: ComposedDisplayPen): string => `${pen.tagId ?? pen.path} (${pen.label}, ${pen.unit}, ${pen.role})`

const thresholdText = (threshold: ComposedTrendThreshold, unit: ProcessUnit): string =>
  `${threshold.kind === 'control' ? 'I&C control set point marked on the axis' : `I&C ${threshold.kind} line`} for ${threshold.signals.join(', ')}: ${threshold.label}, ${operatorText[threshold.operator]} ${threshold.value} ${unit}${threshold.modeLabel === undefined ? '' : ` (only in ${threshold.modeLabel})`}`

/** How each requested reference resolved, so the agent learns exact tags, paths and units. */
export const composedDisplaySignals = (display: CompiledComposedDisplay): ReadonlyArray<{
  readonly ref: string
  readonly tagId?: string
  readonly path: string
  readonly label: string
  readonly unit: string
}> => display.panels.flatMap(panel => panel.kind === 'alarms' ? [] : panel.pens.map(pen => ({
  ref: pen.ref,
  ...(pen.tagId === undefined ? {} : { tagId: pen.tagId }),
  path: String(pen.path),
  label: pen.label,
  unit: pen.unit,
})))

/** Plain statements of what the view shows, so the agent's text need not repeat it. */
export const composedDisplayShows = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => {
  if (panel.kind === 'trend') return [`Live trend of the last ${panel.horizon}: ${panel.pens.map(signalName).join('; ')}`, ...panel.thresholds.map(threshold => thresholdText(threshold, panel.unit))]
  if (panel.kind === 'comparison') return [`Live side-by-side comparison with the median: ${panel.pens.map(signalName).join('; ')}`, ...panel.thresholds.map(threshold => thresholdText(threshold, panel.unit))]
  if (panel.kind === 'readouts') return [`Live readouts with margin to the nearest I&C alarm or trip threshold: ${panel.pens.map(signalName).join('; ')}`]
  return [panel.scope === 'related' ? `Active alarms and trips of the ${panel.ruleIds.length} I&C rules acting on the displayed signals` : 'All active alarms and trips of the Plant']
})

export const composedDisplayWarnings = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => {
  if (panel.kind === 'alarms') return panel.scope === 'related' && panel.ruleIds.length === 0 ? ['No alarm or trip rule acts on the displayed signals; the related alarms panel will stay empty.'] : []
  return panel.pens.flatMap(pen => [
    ...(panel.kind === 'trend' && pen.role === 'primary' && pen.thresholds.length === 0 ? [`No single-signal I&C threshold acts on ${pen.tagId ?? pen.path}; its trend shows values without threshold lines.`] : []),
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
