import { z } from 'zod'

// Canonical schema for hand-authored repo-tracked overlays (e.g. scenario-specific
// exclusion zones). Simpler than the airspace schema — these aren't parsed from a
// feed so there's no classLetter, frequency, callsign, etc.

export const manualOverlayCategorySchema = z.enum([
  'exclusion',
  'restricted',
  'danger',
  'training',
  'reference',
])

export const manualOverlaySchema = z.object({
  name: z.string().min(1),
  category: manualOverlayCategorySchema,
  floorM: z.number().nullable(),
  ceilingM: z.number().nullable(),
  floorLabel: z.string().min(1),
  ceilingLabel: z.string().min(1),
  remarks: z.string().nullable().optional(),
  source: z.literal('manual'),
})

export type ManualOverlayProperties = z.infer<typeof manualOverlaySchema>
