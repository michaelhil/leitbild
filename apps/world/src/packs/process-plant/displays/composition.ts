import { z } from 'zod'
import { idSchema, isoTimestampSchema } from '../../../core/model/index.ts'

// An AI-composed display states WHAT the operator should see and WHY. The
// Pack owns HOW: resolution, units, I&C thresholds, scales, layout and live
// data. There are deliberately no fields for numbers, limits, colours,
// positions or forecasts.
export const COMPOSED_DISPLAY_VIEW_TYPE = 'process-plant.display'

export const composedDisplayHorizonMs = {
  '2m': 120_000,
  '10m': 600_000,
  '30m': 1_800_000,
} as const
export const composedDisplayHorizonSchema = z.enum(['2m', '10m', '30m'])
export type ComposedDisplayHorizon = z.infer<typeof composedDisplayHorizonSchema>

export const composedDisplaySignalRoleSchema = z.enum(['primary', 'context', 'counter-evidence'])
export type ComposedDisplaySignalRole = z.infer<typeof composedDisplaySignalRoleSchema>

const text = (min: number, max: number) => z.string().trim().min(min).max(max)

export const composedDisplaySignalSchema = z.object({
  ref: text(1, 120),
  role: composedDisplaySignalRoleSchema,
}).strict()
export type ComposedDisplaySignal = z.infer<typeof composedDisplaySignalSchema>

// Size limits keep a chat display glanceable; larger questions belong to the
// Plant's own displays.
export const COMPOSED_TREND_MAX_PENS = 3
export const COMPOSED_COMPARISON_MAX_SIGNALS = 6
export const COMPOSED_READOUTS_MAX_SIGNALS = 6
export const COMPOSED_DISPLAY_MAX_PANELS = 4
export const COMPOSED_DISPLAY_MAX_TRENDS = 2

export const composedDisplayTrendPanelSchema = z.object({
  kind: z.literal('trend'),
  horizon: composedDisplayHorizonSchema,
  signals: z.array(composedDisplaySignalSchema).min(1).max(COMPOSED_TREND_MAX_PENS),
}).strict()
export type ComposedDisplayTrendPanel = z.infer<typeof composedDisplayTrendPanelSchema>

/** Parallel signals of one unit side by side, e.g. the four loops. */
export const composedDisplayComparisonPanelSchema = z.object({
  kind: z.literal('comparison'),
  signals: z.array(composedDisplaySignalSchema).min(2).max(COMPOSED_COMPARISON_MAX_SIGNALS),
}).strict()

/** Current values, including on/off states, with margin to I&C thresholds. */
export const composedDisplayReadoutsPanelSchema = z.object({
  kind: z.literal('readouts'),
  signals: z.array(composedDisplaySignalSchema).min(1).max(COMPOSED_READOUTS_MAX_SIGNALS),
}).strict()

/** Active alarms and trips: those acting on the displayed signals, or the whole Plant. */
export const composedDisplayAlarmsPanelSchema = z.object({
  kind: z.literal('alarms'),
  scope: z.enum(['related', 'plant']),
}).strict()

export const composedDisplayPanelSchema = z.discriminatedUnion('kind', [
  composedDisplayTrendPanelSchema,
  composedDisplayComparisonPanelSchema,
  composedDisplayReadoutsPanelSchema,
  composedDisplayAlarmsPanelSchema,
])
export type ComposedDisplayPanel = z.infer<typeof composedDisplayPanelSchema>

export const composedDisplayCompositionSchema = z.object({
  plantId: idSchema,
  title: text(3, 60),
  question: text(8, 160),
  need: text(8, 160),
  panels: z.array(composedDisplayPanelSchema).min(1).max(COMPOSED_DISPLAY_MAX_PANELS),
}).strict()
export type ComposedDisplayComposition = z.infer<typeof composedDisplayCompositionSchema>

// Opaque to embedders. The issue time and model digest let a later view say
// when the advice was given and whether the Plant model has changed since.
export const composedDisplayStateSchema = z.object({
  composition: composedDisplayCompositionSchema,
  issuedAt: isoTimestampSchema,
  modelDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export type ComposedDisplayState = z.infer<typeof composedDisplayStateSchema>

// One layout used by the compiler (to size the embedded card) and by the view
// (to size each panel), so the reserved frame always fits what is drawn.
export const composedDisplayLayout = {
  /** Header, two-line caption, one reserved notice line, footer, gaps and padding. */
  frame: 124,
  /** Chart plus its legend row. */
  trend: 192,
  trendChart: 156,
  comparisonHeader: 22,
  comparisonRow: 24,
  readoutsPerRow: 3,
  readoutsRow: 58,
  /** Title row plus four alarm rows; more are summarised as a count. */
  alarms: 110,
  alarmRows: 4,
  panelGap: 6,
} as const

// Embedders accept view heights up to 720 px; a composition must fit.
export const COMPOSED_DISPLAY_MAX_HEIGHT_PX = 720

export const composedPanelHeight = (panel: ComposedDisplayPanel): number => {
  const layout = composedDisplayLayout
  if (panel.kind === 'trend') return layout.trend
  if (panel.kind === 'comparison') return layout.comparisonHeader + layout.comparisonRow * panel.signals.length
  if (panel.kind === 'readouts') return layout.readoutsRow * Math.ceil(panel.signals.length / layout.readoutsPerRow)
  return layout.alarms
}

export const composedDisplayHeight = (composition: ComposedDisplayComposition): number =>
  composedDisplayLayout.frame
  + composition.panels.reduce((sum, panel) => sum + composedPanelHeight(panel), 0)
  + composedDisplayLayout.panelGap * (composition.panels.length - 1)
