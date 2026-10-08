import { z } from 'zod'
import { idSchema, isoTimestampSchema } from '../../../core/model/index.ts'

// An AI-composed display states WHAT the operator should see and WHY. The
// Pack owns HOW: resolution, units, I&C thresholds, scales, layout and live
// data. There are deliberately no fields for numbers, limits, colours,
// positions or forecasts.
export const COMPOSED_DISPLAY_VIEW_TYPE = 'process-plant.display'

// Card height reserved by embedders before the view loads (header, caption,
// one trend panel and its legend at chat width).
export const COMPOSED_DISPLAY_HEIGHT_PX = 340

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

export const COMPOSED_TREND_MAX_PENS = 3

export const composedDisplayTrendPanelSchema = z.object({
  kind: z.literal('trend'),
  horizon: composedDisplayHorizonSchema,
  signals: z.array(composedDisplaySignalSchema).min(1).max(COMPOSED_TREND_MAX_PENS),
}).strict()
export type ComposedDisplayTrendPanel = z.infer<typeof composedDisplayTrendPanelSchema>

export const composedDisplayPanelSchema = z.discriminatedUnion('kind', [composedDisplayTrendPanelSchema])
export type ComposedDisplayPanel = z.infer<typeof composedDisplayPanelSchema>

export const composedDisplayCompositionSchema = z.object({
  plantId: idSchema,
  title: text(3, 60),
  question: text(8, 160),
  need: text(8, 160),
  panels: z.array(composedDisplayPanelSchema).length(1),
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
