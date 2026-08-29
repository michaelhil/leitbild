import { z } from 'zod'

export type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type ObjectId = Brand<string, 'ObjectId'>
export type SimulationRunId = Brand<string, 'SimulationRunId'>
export type CommandId = Brand<string, 'CommandId'>
export type ActorId = Brand<string, 'ActorId'>
export type ClientId = Brand<string, 'ClientId'>
export type PackId = Brand<string, 'PackId'>
export type AdapterId = Brand<string, 'AdapterId'>
export type EventId = Brand<string, 'EventId'>
export type SignalId = Brand<string, 'SignalId'>
export type NotificationId = Brand<string, 'NotificationId'>

export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)

export const objectIdSchema = idSchema.transform(value => value as ObjectId)
export const simulationRunIdSchema = z.string()
  .regex(/^run-[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .max(128)
  .transform(value => value as SimulationRunId)
export const commandIdSchema = idSchema.transform(value => value as CommandId)
export const actorIdSchema = idSchema.transform(value => value as ActorId)
export const clientIdSchema = idSchema.transform(value => value as ClientId)
export const packIdSchema = idSchema.transform(value => value as PackId)
export const adapterIdSchema = idSchema.transform(value => value as AdapterId)
export const eventIdSchema = idSchema.transform(value => value as EventId)
export const signalIdSchema = idSchema.transform(value => value as SignalId)
export const notificationIdSchema = idSchema.transform(value => value as NotificationId)

export const makeId = <T extends string>(prefix: string, value: string): Brand<string, T> =>
  `${prefix}:${value}` as Brand<string, T>
