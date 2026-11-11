import { z } from 'zod'

/** A World item, as `<owning Pack id>/<Pack-local path>`. Planning stores it and never parses the rest. */
export const planningLocatorSchema = z.string().min(3).max(512)
  .regex(/^[a-z][a-z0-9-]*\//, 'A locator starts with its owning Pack id and a slash')
export type PlanningLocator = z.infer<typeof planningLocatorSchema>

/**
 * How a value is known. design: a declared model or type value. configured: set by the Scenario or an
 * operator and changeable during a Run (Einsatz typed properties). observed: a reading at `at`.
 * owner-estimate: the owning Pack's prediction.
 */
export const planningFactBasisSchema = z.enum(['design', 'configured', 'observed', 'owner-estimate'])
export type PlanningFactBasis = z.infer<typeof planningFactBasisSchema>

export const planningFactSchema = z.object({
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(160),
  quantity: z.string().min(1).max(64),
  unit: z.string().min(1).max(32).optional(),
  value: z.union([z.number().finite(), z.string().max(512), z.boolean()]),
  basis: planningFactBasisSchema,
  // The simulation instant the value describes; each fact keeps its own.
  at: z.iso.datetime(),
}).strict().superRefine((fact, context) => {
  if (typeof fact.value === 'number' && fact.unit === undefined) context.addIssue({ code: 'custom', path: ['unit'], message: 'A number fact carries its unit' })
})
export type PlanningFact = z.infer<typeof planningFactSchema>

export const planningSubjectSchema = z.object({
  locator: planningLocatorSchema,
  label: z.string().min(1).max(160),
  kind: z.string().min(1).max(80),
  facts: z.array(planningFactSchema).max(128),
}).strict()
export type PlanningSubject = z.infer<typeof planningSubjectSchema>

/** World core to a Pack's planning projection. `facts` reads every requested subject in this one request. */
export const planningProjectionInputSchema = z.object({
  subjects: z.array(planningLocatorSchema).min(1).max(32).optional(),
  detail: z.enum(['index', 'facts']),
}).strict()
export type PlanningProjectionInput = z.infer<typeof planningProjectionInputSchema>

export const planningProjectionOutputSchema = z.object({
  simulationAt: z.iso.datetime(),
  subjects: z.array(planningSubjectSchema).max(256),
}).strict()
export type PlanningProjectionOutput = z.infer<typeof planningProjectionOutputSchema>

/** Input of world.simulation-run.planning-facts: search with text or kind, or read exact subjects. */
export const planningFactsInputSchema = z.object({
  text: z.string().trim().min(1).max(120).optional().describe('Words to find in names, e.g. "feed pump" or "truck". All words must match.'),
  kind: z.string().max(80).optional().describe('Only items of this kind, as named in a previous answer, e.g. "pump".'),
  subjects: z.array(planningLocatorSchema).min(1).max(32).optional().describe('Exact locators from a previous answer, to get all their values, read together. Not with text, kind or limit.'),
  limit: z.number().int().min(1).max(20).optional().describe('Items per page when searching; default 10.'),
  cursor: z.string().max(512).optional().describe('The "more" value of the previous page.'),
}).strict().superRefine((input, context) => {
  if (input.subjects === undefined) return
  for (const field of ['text', 'kind', 'limit'] as const) {
    if (input[field] !== undefined) context.addIssue({ code: 'custom', path: [field], message: `Exact subjects are read without ${field}` })
  }
})
export type PlanningFactsInput = z.infer<typeof planningFactsInputSchema>

export const planningFactsOutputSchema = z.object({
  run: z.object({ workspaceId: z.string(), moduleId: z.literal('world'), type: z.literal('world.simulation-run'), id: z.string() }).strict(),
  // Wall time of the read; each fact keeps its own simulation `at`.
  observedAt: z.iso.datetime(),
  items: z.array(planningSubjectSchema),
  more: z.string().max(512).optional(),
}).strict()
export type PlanningFactsOutput = z.infer<typeof planningFactsOutputSchema>
