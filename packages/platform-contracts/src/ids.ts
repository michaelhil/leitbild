import { z } from 'zod'

export const workspaceIdSchema = z.uuid().brand<'WorkspaceId'>()
export type WorkspaceId = z.infer<typeof workspaceIdSchema>

export const moduleIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .brand<'ModuleId'>()
export type ModuleId = z.infer<typeof moduleIdSchema>

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

export const protocolVersionSchema = z.string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .brand<'ProtocolVersion'>()
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>

export const isoTimestampSchema = z.iso.datetime({ offset: true })
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>

export const newWorkspaceId = (): WorkspaceId => workspaceIdSchema.parse(crypto.randomUUID())
export const newRequestId = (): RequestId => requestIdSchema.parse(crypto.randomUUID())
export const newPlatformEventId = (): PlatformEventId => eventIdSchema.parse(crypto.randomUUID())
