import { z } from 'zod'

export type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type ObjectId = Brand<string, 'ObjectId'>
export type ControlInstanceId = Brand<string, 'ControlInstanceId'>
export type CommandId = Brand<string, 'CommandId'>
export type ActorId = Brand<string, 'ActorId'>
export type ClientId = Brand<string, 'ClientId'>
export type DomainId = Brand<string, 'DomainId'>
export type AdapterId = Brand<string, 'AdapterId'>
export type EventId = Brand<string, 'EventId'>

export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)

export const objectIdSchema = idSchema.transform(value => value as ObjectId)
export const controlInstanceIdSchema = idSchema.transform(value => value as ControlInstanceId)
export const commandIdSchema = idSchema.transform(value => value as CommandId)
export const actorIdSchema = idSchema.transform(value => value as ActorId)
export const clientIdSchema = idSchema.transform(value => value as ClientId)
export const domainIdSchema = idSchema.transform(value => value as DomainId)
export const adapterIdSchema = idSchema.transform(value => value as AdapterId)
export const eventIdSchema = idSchema.transform(value => value as EventId)

export const makeId = <T extends string>(prefix: string, value: string): Brand<string, T> =>
  `${prefix}:${value}` as Brand<string, T>
