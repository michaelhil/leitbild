import { z } from 'zod'

export const workspaceIdSchema = z.uuid().brand<'WorkspaceId'>()
export type WorkspaceId = z.infer<typeof workspaceIdSchema>

export const moduleIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .brand<'ModuleId'>()
export type ModuleId = z.infer<typeof moduleIdSchema>

export const experienceIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .brand<'ExperienceId'>()
export type ExperienceId = z.infer<typeof experienceIdSchema>

export const capabilityIdSchema = z.string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .brand<'CapabilityId'>()
export type CapabilityId = z.infer<typeof capabilityIdSchema>

export const resourceTypeSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .brand<'ResourceType'>()
export type ResourceType = z.infer<typeof resourceTypeSchema>

export const resourceIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/)
  .brand<'ResourceId'>()
export type ResourceId = z.infer<typeof resourceIdSchema>

export const requestIdSchema = z.uuid().brand<'RequestId'>()
export type RequestId = z.infer<typeof requestIdSchema>

export const eventIdSchema = z.uuid().brand<'PlatformEventId'>()
export type PlatformEventId = z.infer<typeof eventIdSchema>

export const bindingIdSchema = z.uuid().brand<'BindingId'>()
export type BindingId = z.infer<typeof bindingIdSchema>

export const semanticVersionSchema = z.string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .brand<'SemanticVersion'>()
export type SemanticVersion = z.infer<typeof semanticVersionSchema>

export const isoTimestampSchema = z.iso.datetime({ offset: true })
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>

export const newWorkspaceId = (): WorkspaceId => workspaceIdSchema.parse(crypto.randomUUID())
export const newRequestId = (): RequestId => requestIdSchema.parse(crypto.randomUUID())
export const newPlatformEventId = (): PlatformEventId => eventIdSchema.parse(crypto.randomUUID())
export const newBindingId = (): BindingId => bindingIdSchema.parse(crypto.randomUUID())
