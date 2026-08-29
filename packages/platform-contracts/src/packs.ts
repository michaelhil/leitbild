import { z } from 'zod'
import { moduleIdSchema, protocolVersionSchema } from './ids.ts'

const packTokenSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)

export const packContributionDescriptorSchema = z.object({
  kind: packTokenSchema,
  id: packTokenSchema.optional(),
}).strict()
export type PackContributionDescriptor = z.infer<typeof packContributionDescriptorSchema>

export const packDependencySchema = z.object({
  id: packTokenSchema,
  versionRange: z.string().min(1),
}).strict()

export const packDescriptorSchema = z.object({
  schemaVersion: protocolVersionSchema,
  id: packTokenSchema,
  moduleId: moduleIdSchema,
  version: protocolVersionSchema,
  name: z.string().min(1).max(256),
  description: z.string().min(1).max(2048).optional(),
  platformVersionRange: z.string().min(1),
  dependencies: z.array(packDependencySchema).default([]),
  contributions: z.array(packContributionDescriptorSchema).min(1),
}).strict().superRefine((descriptor, ctx) => {
  const dependencyIds = new Set<string>()
  descriptor.dependencies.forEach((dependency, index) => {
    if (dependency.id === descriptor.id) {
      ctx.addIssue({ code: 'custom', path: ['dependencies', index, 'id'], message: 'pack cannot depend on itself' })
    }
    if (dependencyIds.has(dependency.id)) {
      ctx.addIssue({ code: 'custom', path: ['dependencies', index, 'id'], message: `duplicate dependency: ${dependency.id}` })
    }
    dependencyIds.add(dependency.id)
  })

  const contributionKeys = new Set<string>()
  descriptor.contributions.forEach((contribution, index) => {
    const key = `${contribution.kind}:${contribution.id ?? ''}`
    if (contributionKeys.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['contributions', index], message: `duplicate contribution: ${key}` })
    }
    contributionKeys.add(key)
  })
})
export type PackDescriptor = z.infer<typeof packDescriptorSchema>

export const capabilityDescriptorSchema = z.object({
  id: packTokenSchema,
  kind: z.enum(['command', 'query', 'stream', 'surface', 'tool', 'skill', 'data']),
  packId: packTokenSchema,
  version: protocolVersionSchema,
  description: z.string().min(1).max(2048).optional(),
}).strict()
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>

export const capabilityManifestSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  capabilities: z.array(capabilityDescriptorSchema),
}).strict()
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>
