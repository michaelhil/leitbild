import { z } from 'zod'

export type IsoTimestamp = string & { readonly __brand: 'IsoTimestamp' }

export const isoTimestampSchema = z.string().datetime().transform(value => value as IsoTimestamp)

export const nowIso = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp
