/**
 * A Run's stored dashboards (A4, D-I): `runs/<id>/dashboards.json` holds, per scope, the pins people and the Assistant
 * put on it and a revision that refuses a stale change, and nothing else (D-72: no history, revert or Undo). A pin holds
 * a vignette state by value, as an answer's vignette is held. World computes each scope's default and never stores it.
 * The file is read when a dashboard is asked for, never when the Run loads; a copy of the Run copies it; a reset keeps it.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { objectIdSchema } from '../../../core/model/ids.ts'
import { writeAtomic } from '../../../core/storage/atomic-write.ts'
import { collectionSchema, vignetteStateSchema } from '../compose/model.ts'

export const DASHBOARD_MAX_PINS = 8
/** The most scopes one Run stores: it bounds the file (a pin's state is at most 4,096 characters). */
export const DASHBOARD_MAX_SCOPES = 64

/** The Run, one object (a subject), or a live collection of one presentation category. */
export const dashboardScopeSchema = z.union([
  z.literal('run'),
  z.object({ objectId: objectIdSchema }).strict(),
  z.object({ of: collectionSchema }).strict(),
])
export type DashboardScope = z.output<typeof dashboardScopeSchema>

/** One key per scope: a collection's status words in any order and case are one scope. */
export const scopeKey = (scope: DashboardScope): string => scope === 'run' ? 'run' : 'objectId' in scope ? `object:${scope.objectId}`
  : `collection:${JSON.stringify([scope.of.packId, scope.of.categoryId, scope.of.closed, [...scope.of.status ?? []].map(word => word.toLowerCase()).sort(), scope.of.near ?? null, scope.of.within ?? null])}`

export const pinIdSchema = z.string().regex(/^pin-[0-9a-f]{8}$/)
export const pinSchema = z.object({ id: pinIdSchema, by: z.enum(['agent', 'person']), spec: vignetteStateSchema }).strict()
export type DashboardPin = z.output<typeof pinSchema>

const dashboardSchema = z.object({
  scope: dashboardScopeSchema,
  revision: z.number().int().positive(),
  pins: z.array(pinSchema).max(DASHBOARD_MAX_PINS),
}).strict().refine(dashboard => new Set(dashboard.pins.map(pin => pin.id)).size === dashboard.pins.length, { message: 'a dashboard holds each pin once', path: ['pins'] })
export type StoredDashboard = z.output<typeof dashboardSchema>

export const dashboardsFileSchema = z.object({ dashboards: z.array(dashboardSchema).max(DASHBOARD_MAX_SCOPES) }).strict()
  .refine(file => new Set(file.dashboards.map(entry => scopeKey(entry.scope))).size === file.dashboards.length, { message: 'a scope is stored once', path: ['dashboards'] })
export type DashboardsFile = z.output<typeof dashboardsFileSchema>

/** None stored reads as no dashboards; a file that does not parse fails visibly, as the Run's and never as the caller's. */
export const readDashboards = async (path: string): Promise<DashboardsFile> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { dashboards: [] }
    throw error
  }
  try {
    return dashboardsFileSchema.parse(JSON.parse(text) as unknown)
  } catch (error) {
    throw Object.assign(new Error(`The Run's dashboards.json is unreadable: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`), { code: 'dashboards_unreadable' })
  }
}

export const writeDashboards = async (path: string, file: DashboardsFile): Promise<void> => {
  await writeAtomic(path, `${JSON.stringify(dashboardsFileSchema.parse(file))}\n`)
}

/** A Run's dashboards file: read on demand; `change` reads, applies and writes it as one step of the Run's lifecycle. */
export interface DashboardFile {
  readonly read: () => Promise<DashboardsFile>
  readonly change: <T>(apply: (file: DashboardsFile) => { readonly next?: DashboardsFile; readonly result: T }) => Promise<T>
}
