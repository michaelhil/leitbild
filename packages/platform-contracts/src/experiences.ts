import { z } from 'zod'
import { experienceIdSchema, moduleIdSchema } from './ids.ts'

export const experienceDescriptorSchema = z.object({
  id: experienceIdSchema,
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2048).optional(),
  requiredModules: z.array(moduleIdSchema).min(1),
  entryModuleId: moduleIdSchema,
}).strict().superRefine((experience, ctx) => {
  const seen = new Set<string>()
  experience.requiredModules.forEach((moduleId, index) => {
    if (seen.has(moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['requiredModules', index], message: `duplicate required Module: ${moduleId}` })
    }
    seen.add(moduleId)
  })
  if (!seen.has(experience.entryModuleId)) {
    ctx.addIssue({ code: 'custom', path: ['entryModuleId'], message: 'Experience entry Module must be one of its required Modules' })
  }
})
export type ExperienceDescriptor = z.infer<typeof experienceDescriptorSchema>

export const workspaceExperienceSchema = experienceDescriptorSchema.extend({
  status: z.enum(['absent', 'ready', 'degraded']),
}).strict()
export type WorkspaceExperience = z.infer<typeof workspaceExperienceSchema>
