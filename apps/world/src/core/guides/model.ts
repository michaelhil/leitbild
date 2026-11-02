import { z } from 'zod'
import { presentationActionSchema } from '@leitbild/contracts'
import { idSchema, objectIdSchema } from '../model/ids.ts'
import { observableRefSchema } from '../model/alerts.ts'
import { quantitySchema, quantityUnits } from '../observation/model.ts'

export const guideControlTargets = [
  { id: 'view', label: 'View controls' }, { id: 'guide', label: 'Guide' }, { id: 'alarms', label: 'Alarms' },
  { id: 'dashboard', label: 'Dashboard' }, { id: 'assistant', label: 'Assistant' },
] as const

/** World owns these semantic targets; a browser decides their current availability. */
export const guideTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), objectId: objectIdSchema, elementId: idSchema.optional(), lateBound: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal('panel'), panelId: idSchema }).strict(),
  z.object({ kind: z.literal('control'), controlId: idSchema }).strict(),
  z.object({ kind: z.literal('composer') }).strict(),
])
export type GuideTarget = z.infer<typeof guideTargetSchema>

/** Small typed conditions over existing World evidence, not an expression language or procedure engine. */
export const guideConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clock'), afterSeconds: z.number().finite().nonnegative().optional(), beforeSeconds: z.number().finite().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('object-status'), objectId: objectIdSchema, status: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('observation'), ref: observableRefSchema,
    operator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']), value: z.union([z.number().finite(), z.boolean(), z.string().min(1).max(128)]),
    quantity: quantitySchema, unit: z.string().max(16), maxAgeSeconds: z.number().finite().positive(),
  }).strict(),
]).superRefine((condition, ctx) => {
  if (condition.kind === 'clock' && (condition.afterSeconds === undefined && condition.beforeSeconds === undefined
    || condition.afterSeconds !== undefined && condition.beforeSeconds !== undefined && condition.afterSeconds > condition.beforeSeconds)) {
    ctx.addIssue({ code: 'custom', message: 'A clock condition needs an ordered simulation-time bound' })
  }
  if (condition.kind === 'observation' && !(quantityUnits[condition.quantity] as readonly string[]).includes(condition.unit)) {
    ctx.addIssue({ code: 'custom', path: ['unit'], message: `Unit does not belong to ${condition.quantity}` })
  }
  if (condition.kind === 'observation' && typeof condition.value !== 'number' && condition.operator !== 'eq') ctx.addIssue({ code: 'custom', path: ['operator'], message: 'Ordered comparisons require a numeric expected value' })
})
export type GuideCondition = z.infer<typeof guideConditionSchema>

export const guideEffectSchema = z.object({ id: idSchema, target: guideTargetSchema, action: presentationActionSchema }).strict()
export const guideStepSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(120),
  instruction: z.string().min(1).max(2_000),
  help: z.string().min(1).max(2_000).optional(),
  // In a role Run this step is eligible only for one of these held roles; omitted means public.
  roles: z.array(idSchema).min(1).optional(),
  effects: z.array(guideEffectSchema).default([]),
  completion: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('acknowledge') }).strict(),
    z.object({ kind: z.literal('condition'), condition: guideConditionSchema }).strict(),
    z.object({ kind: z.literal('presentation'), effectId: idSchema }).strict(),
    z.object({ kind: z.literal('prompt-response'), effectId: idSchema }).strict(),
  ]),
  // Omitted proceeds to the next eligible authored step. No loops or arbitrary branching code.
  next: idSchema.optional(),
}).strict()
export type GuideStep = z.infer<typeof guideStepSchema>

export const guideDefinitionSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2_000).optional(),
  startPaused: z.boolean().default(true),
  // An initial-state lesson can explicitly refuse a copied checkpoint after its introduction is no longer true.
  entry: guideConditionSchema.optional(),
  steps: z.array(guideStepSchema).min(1),
}).strict().superRefine((guide, ctx) => {
  const indices = new Map<string, number>()
  guide.steps.forEach((step, index) => {
    if (indices.has(step.id)) ctx.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: 'Guide step identities must be unique' })
    indices.set(step.id, index)
    const effects = new Set<string>()
    step.effects.forEach((effect, at) => {
      if (effects.has(effect.id)) ctx.addIssue({ code: 'custom', path: ['steps', index, 'effects', at, 'id'], message: 'A step effect identity occurs once' })
      effects.add(effect.id)
      if (effect.action.kind === 'clear') ctx.addIssue({ code: 'custom', path: ['steps', index, 'effects', at], message: 'Guide effect cleanup is owned by the current attempt; authored steps do not name old delivery IDs' })
      if (effect.action.kind === 'draft' && effect.target.kind !== 'composer') ctx.addIssue({ code: 'custom', path: ['steps', index, 'effects', at], message: 'A prompt draft targets the Agents composer' })
      if (effect.target.kind === 'composer' && effect.action.kind !== 'draft') ctx.addIssue({ code: 'custom', path: ['steps', index, 'effects', at], message: 'The composer accepts prompt suggestions only' })
    })
  })
  guide.steps.forEach((step, index) => {
    if (step.next !== undefined && (!indices.has(step.next) || indices.get(step.next)! <= index)) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'next'], message: 'Next names a later authored step; guide cycles are not supported' })
    }
    const completion = step.completion
    if ((completion.kind === 'presentation' || completion.kind === 'prompt-response') && !step.effects.some(effect => effect.id === completion.effectId)) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'completion'], message: 'Presentation completion names an effect in this step' })
    }
    if (completion.kind === 'prompt-response' && !step.effects.some(effect => effect.id === completion.effectId && effect.action.kind === 'draft')) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'completion'], message: 'An Assistant response task names this step\'s offered prompt' })
    }
  })
})
export type GuideDefinition = z.infer<typeof guideDefinitionSchema>

/** Static symbol/role checks do not pretend a feed, browser document or future object already exists. */
export const guideReferenceIssues = (guide: GuideDefinition, objectIds: ReadonlySet<string>, roleIds: ReadonlySet<string>) => {
  const issues: Array<{ path: Array<string | number>; message: string }> = []
  guide.steps.forEach((step, index) => {
    for (const role of step.roles ?? []) if (!roleIds.has(role)) issues.push({ path: ['steps', index, 'roles'], message: `Unknown guide role: ${role}` })
    // Operational objects may be created later by an admitted timeline; availability is checked when the step runs.
    for (const [at, effect] of step.effects.entries()) {
      if (effect.target.kind === 'object' && effect.target.lateBound !== true && !objectIds.has(effect.target.objectId)) {
        issues.push({ path: ['steps', index, 'effects', at, 'target'], message: `Unknown authored guide object: ${effect.target.objectId}` })
      }
    }
  })
  return issues
}

export interface GuideConditionResult {
  readonly status: 'satisfied' | 'contradicted' | 'unknown' | 'stale' | 'refused'
  readonly reason: string
  readonly at: string
  readonly sequence: number
  readonly value?: number | string | boolean
  readonly clock?: 'simulation' | 'wall'
  readonly ref?: string
  readonly unit?: string
}
