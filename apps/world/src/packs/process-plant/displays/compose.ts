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
  composedDisplayCompositionSchema,
  composedDisplayHorizonMs,
  type ComposedDisplayComposition,
  type ComposedDisplayHorizon,
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
  readonly seriesId: string
  readonly limits?: ProcessVariableLimits
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly combinedRules: ReadonlyArray<ComposedDisplayCombinedRule>
}

export interface ComposedTrendPanel {
  readonly kind: 'trend'
  readonly horizon: ComposedDisplayHorizon
  readonly horizonMs: number
  readonly unit: ProcessUnit
  readonly pens: ReadonlyArray<ComposedDisplayPen>
}

export interface CompiledComposedDisplay {
  readonly plantId: string
  readonly title: string
  readonly question: string
  readonly need: string
  readonly modelDigest: string
  readonly panels: ReadonlyArray<ComposedTrendPanel>
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

const compileTrendPanel = (
  system: ProcessPlantRuntimeInstance,
  panel: ComposedDisplayComposition['panels'][number],
  panelIndex: number,
  issues: ComposedDisplayIssue[],
): ComposedTrendPanel | undefined => {
  const pens: ComposedDisplayPen[] = []
  const seen = new Set<VariablePath>()
  panel.signals.forEach((signal, signalIndex) => {
    const path = `panels.${panelIndex}.signals.${signalIndex}.ref`
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
      issues.push({ path, message: `"${signal.ref}" repeats a signal already in this trend` })
      return
    }
    seen.add(binding.path)
    const value = system.runtime.readVariableSnapshot(binding.path).value
    if (typeof value !== 'number') {
      issues.push({ path, message: `"${signal.ref}" is a ${typeof value} state signal; trend panels show numeric signals only` })
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
      seriesId: recordingSeriesIdFor(system.plant.id, binding.path),
      ...(binding.limits === undefined ? {} : { limits: binding.limits }),
      thresholds,
      combinedRules,
    })
  })
  if (!panel.signals.some(signal => signal.role === 'primary')) {
    issues.push({ path: `panels.${panelIndex}.signals`, message: 'a trend needs at least one signal with role "primary"' })
  }
  const units = [...new Set(pens.map(pen => pen.unit))]
  if (units.length > 1) {
    issues.push({
      path: `panels.${panelIndex}.signals`,
      message: `one trend shares one value axis, but these signals use ${units.join(', ')}; keep signals of one unit in the trend`,
    })
  }
  if (pens.length !== panel.signals.length || units.length !== 1) return undefined
  return { kind: 'trend', horizon: panel.horizon, horizonMs: composedDisplayHorizonMs[panel.horizon], unit: units[0]!, pens }
}

export const compileComposedDisplay = (
  system: ProcessPlantRuntimeInstance,
  input: unknown,
): ComposedDisplayCompileResult => {
  const parsed = composedDisplayCompositionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const composition = parsed.data
  const issues: ComposedDisplayIssue[] = []
  if (composition.plantId !== system.plant.id) {
    issues.push({ path: 'plantId', message: `composition targets ${composition.plantId}, not ${system.plant.id}` })
  }
  const panels = composition.panels.map((panel, index) => compileTrendPanel(system, panel, index, issues))
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    display: {
      plantId: system.plant.id,
      title: composition.title,
      question: composition.question,
      need: composition.need,
      modelDigest: system.plant.modelDigest,
      panels: panels.filter((panel): panel is ComposedTrendPanel => panel !== undefined),
    },
  }
}

const operatorText = { '<': 'below', '<=': 'at or below', '>': 'above', '>=': 'at or above' } as const

/** Plain statements of what the view shows, so the agent's text need not repeat it. */
export const composedDisplayShows = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => [
  `Live trend of the last ${panel.horizon}: ${panel.pens.map(pen => `${pen.tagId ?? pen.path} (${pen.label}, ${pen.unit}, ${pen.role})`).join('; ')}`,
  ...panel.pens.flatMap(pen => pen.thresholds.map(threshold =>
    `${threshold.kind === 'control' ? 'I&C control set point marked on the axis' : `I&C ${threshold.kind} line`} for ${pen.tagId ?? pen.path}: ${threshold.label}, ${operatorText[threshold.operator]} ${threshold.value} ${pen.unit}${threshold.modeLabel === undefined ? '' : ` (only in ${threshold.modeLabel})`}`)),
])

export const composedDisplayWarnings = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => panel.pens.flatMap(pen => [
  ...(pen.thresholds.length === 0 ? [`No single-signal I&C threshold acts on ${pen.tagId ?? pen.path}; its trend shows values without threshold lines.`] : []),
  ...pen.combinedRules.map(rule => `${pen.tagId ?? pen.path} also feeds the combined rule "${rule.label}" (${rule.kind}); it is listed, not drawn.`),
]))

export const formatComposedDisplayIssues = (issues: ReadonlyArray<ComposedDisplayIssue>): string => [
  `Display composition rejected (${issues.length} issue${issues.length === 1 ? '' : 's'}); nothing will be shown. Fix every issue and call world.process-plant.display.compose again:`,
  ...issues.map(issue => `- ${issue.path}: ${issue.message}${issue.didYouMean === undefined ? '' : `. Did you mean: ${issue.didYouMean.join('; ')}`}`),
].join('\n')
