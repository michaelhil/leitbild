import { z } from 'zod'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export const factSourceSchema = z.enum(['scenario', 'simulation', 'operator', 'sensor', 'ai', 'radio', 'message', 'system'])
export type FactSource = z.infer<typeof factSourceSchema>

export interface UnknownFact {
  readonly state: 'unknown'
  readonly updatedAt: IsoTimestamp
  readonly source: FactSource
}

export interface KnownFact<T> {
  readonly state: 'estimated' | 'confirmed'
  readonly value: T
  readonly confidence?: number
  readonly updatedAt: IsoTimestamp
  readonly source: FactSource
}

export type KnowledgeFact<T> = UnknownFact | KnownFact<T>

export const knowledgeFactSchema = <T extends z.ZodTypeAny>(valueSchema: T): z.ZodType<KnowledgeFact<z.infer<T>>> =>
  z.discriminatedUnion('state', [
    z.object({
      state: z.literal('unknown'),
      updatedAt: isoTimestampSchema,
      source: factSourceSchema,
    }),
    z.object({
      state: z.enum(['estimated', 'confirmed']),
      value: valueSchema,
      confidence: z.number().finite().min(0).max(1).optional(),
      updatedAt: isoTimestampSchema,
      source: factSourceSchema,
    }),
  ]) as unknown as z.ZodType<KnowledgeFact<z.infer<T>>>

export const unknownFact = (updatedAt: IsoTimestamp, source: FactSource): UnknownFact => ({
  state: 'unknown',
  updatedAt,
  source,
})

export const estimatedFact = <T>(value: T, updatedAt: IsoTimestamp, source: FactSource, confidence?: number): KnownFact<T> => ({
  state: 'estimated',
  value,
  updatedAt,
  source,
  ...(confidence === undefined ? {} : { confidence }),
})

export const confirmedFact = <T>(value: T, updatedAt: IsoTimestamp, source: FactSource, confidence?: number): KnownFact<T> => ({
  state: 'confirmed',
  value,
  updatedAt,
  source,
  ...(confidence === undefined ? {} : { confidence }),
})
