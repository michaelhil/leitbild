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
export const COMPOSED_TREND_MAX_SIGNALS = 6
/** A trend stacks one strip per unit on its time axis; a strip holds the loops of a 4-loop plant. */
export const COMPOSED_TREND_MAX_STRIPS = 3
export const COMPOSED_TREND_STRIP_MAX_PENS = 4
export const COMPOSED_COMPARISON_MAX_SIGNALS = 6
export const COMPOSED_READOUTS_MAX_SIGNALS = 6
// One trend plus up to two supporting panels (HMI review); with the 640 px cap
// nearly every three-panel combination fits by construction.
export const COMPOSED_DISPLAY_MAX_PANELS = 3
export const COMPOSED_DISPLAY_MAX_TRENDS = 1

/** History of numeric signals; the Pack groups them into one strip per unit. */
export const composedDisplayTrendPanelSchema = z.object({
  kind: z.literal('trend'),
  horizon: composedDisplayHorizonSchema,
  signals: z.array(composedDisplaySignalSchema).min(1).max(COMPOSED_TREND_MAX_SIGNALS),
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
  /** Above each trend strip: unit and advice labels. */
  trendStripTop: 18,
  /** Plot area of a trend with one strip, and of each strip when several stack. */
  trendPlot: 116,
  trendStackedPlot: 72,
  /** Time labels, once under the bottom strip. */
  trendTimeAxis: 22,
  /** Legend under each strip: one row per pen with value, alarm state or margin, and rate. */
  trendLegendRow: 16,
  trendLegendPad: 4,
  comparisonHeader: 22,
  comparisonRow: 24,
  comparisonCaption: 14,
  readoutsPerRow: 3,
  readoutsRow: 74,
  /** Title row plus four alarm rows; more are summarised as a count. */
  alarms: 110,
  alarmRows: 4,
  panelGap: 6,
} as const

// Embedders accept view heights up to 720 px, but a chat display taller than
// about 600 px pushes its own lower panels below the fold (HMI review).
export const COMPOSED_DISPLAY_MAX_HEIGHT_PX = 640

/** What a panel's height depends on, known once its signals are resolved. */
export type ComposedPanelSize =
  /** Pens per strip, top to bottom. */
  | { readonly kind: 'trend'; readonly strips: ReadonlyArray<number> }
  | { readonly kind: 'comparison'; readonly rows: number }
  | { readonly kind: 'readouts'; readonly values: number }
  | { readonly kind: 'alarms' }

/** Chart height of each strip of a trend, top to bottom; the last carries the time axis. */
export const composedTrendStripHeights = (strips: number): ReadonlyArray<number> => {
  const layout = composedDisplayLayout
  const plot = strips === 1 ? layout.trendPlot : layout.trendStackedPlot
  return Array.from({ length: strips }, (_, index) => layout.trendStripTop + plot + (index === strips - 1 ? layout.trendTimeAxis : 0))
}

export const composedTrendLegendHeight = (pens: number): number =>
  composedDisplayLayout.trendLegendPad + composedDisplayLayout.trendLegendRow * pens

export const composedPanelHeight = (panel: ComposedPanelSize): number => {
  const layout = composedDisplayLayout
  if (panel.kind === 'trend') {
    const charts = composedTrendStripHeights(panel.strips.length)
    return panel.strips.reduce((sum, pens, index) => sum + charts[index]! + composedTrendLegendHeight(pens), 0)
  }
  if (panel.kind === 'comparison') return layout.comparisonHeader + layout.comparisonRow * panel.rows + layout.comparisonCaption
  if (panel.kind === 'readouts') return layout.readoutsRow * Math.ceil(panel.values / layout.readoutsPerRow)
  return layout.alarms
}

export const composedDisplayHeight = (panels: ReadonlyArray<ComposedPanelSize>): number =>
  composedDisplayLayout.frame
  + panels.reduce((sum, panel) => sum + composedPanelHeight(panel), 0)
  + composedDisplayLayout.panelGap * (panels.length - 1)
