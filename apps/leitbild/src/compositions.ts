import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { capabilityIdSchema, definitionIdSchema, definitionTypeSchema, moduleIdSchema } from '@leitbild/contracts'

const compositionDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(2048),
  actions: z.array(z.object({
    capabilityId: capabilityIdSchema,
    moduleId: moduleIdSchema,
    definitionType: definitionTypeSchema,
    definitionId: definitionIdSchema,
  }).strict()).min(1),
}).strict().superRefine((composition, ctx) => {
  composition.actions.forEach((action, index) => {
    if (!action.capabilityId.startsWith(`${action.moduleId}.`)) {
      ctx.addIssue({ code: 'custom', path: ['actions', index, 'capabilityId'], message: 'Capability must belong to its Module' })
    }
    if (!action.definitionType.startsWith(`${action.moduleId}.`)) {
      ctx.addIssue({ code: 'custom', path: ['actions', index, 'definitionType'], message: 'Definition type must belong to its Module' })
    }
  })
})
export type CompositionDefinition = z.infer<typeof compositionDefinitionSchema>

const compositionDir = join(dirname(fileURLToPath(import.meta.url)), 'compositions')
const readComposition = (fileName: string): CompositionDefinition =>
  compositionDefinitionSchema.parse(JSON.parse(readFileSync(join(compositionDir, fileName), 'utf8')) as unknown)

// Compositions intentionally contain only independent, apply-once Definition
// starts. They resolve exact current revisions before invoking Modules.
// They are not workflows: no output references, branching, schedules, or state.
export const COMPOSITION_CATALOG: ReadonlyArray<CompositionDefinition> = [
  readComposition('halden-integrated-control-room.composition.json'),
]

export const getComposition = (id: string): CompositionDefinition | undefined =>
  COMPOSITION_CATALOG.find(composition => composition.id === id)
