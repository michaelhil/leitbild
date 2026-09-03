import { createHash } from 'node:crypto'
import { externalGeometrySchema } from '../model.ts'

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
export const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : typeof object(value)['#text'] === 'string' ? object(value)['#text'] as string : ''
export const plain = (value: unknown, max: number): string => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
export const atPath = (value: unknown, path: string): unknown => path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<unknown>((item, part) => item !== null && typeof item === 'object' && Object.hasOwn(item, part) ? (item as Record<string, unknown>)[part] : undefined, value)
export const timestamp = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const date = typeof value === 'number' ? new Date(value) : new Date(text(value))
  if (!Number.isFinite(date.getTime())) throw new Error('Source has an invalid timestamp')
  return date.toISOString()
}
export const stableId = (value: string): string => value.length <= 180 ? value : createHash('sha256').update(value).digest('hex')
export const identity = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32)
export const coordinates2D = (value: unknown): unknown => Array.isArray(value) ? typeof value[0] === 'number' ? value.slice(0, 2) : value.map(coordinates2D) : value
export const geometry = (value: unknown) => value === null || value === undefined ? undefined : externalGeometrySchema.parse({ type: object(value).type, coordinates: coordinates2D(object(value).coordinates) })
export const linkedUrl = (value: unknown, base: string): string => {
  const candidate = text(value)
  return candidate ? new URL(candidate, base).href : base
}
