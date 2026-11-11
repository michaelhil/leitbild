// One JSON file per plan at workspaces/<ws>/planning/plans/<uuid>.json. One writer per Workspace: every
// operation on a Workspace runs in its queue. A write goes to a temporary file that is synced, renamed over
// the plan and followed by a sync of the directory, so an acknowledged save survives a crash and a reader
// never sees half a file. The old studies/ folder is never read.
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { planningError } from '../errors.ts'
import { planSchema, type Plan } from './schema.ts'

const planIdSchema = z.uuid()
const markerSchema = z.object({ workspaceId: workspaceIdSchema, moduleId: z.literal('planning') }).strict()
const temporarySuffix = '.tmp'

export interface DamagedPlan { readonly id: string }
export interface PlanListing { readonly plans: ReadonlyArray<Plan>; readonly damaged: ReadonlyArray<DamagedPlan> }

/** The envelope revision a write states. `required: false` only for delete (L2). */
export interface RevisionGuard { readonly expectedRevision: number | undefined; readonly required: boolean }

export interface PlanStore {
  readonly hasWorkspace: (workspaceId: WorkspaceId) => Promise<boolean>
  readonly provision: (workspaceId: WorkspaceId) => Promise<boolean>
  readonly removeWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** Parses every plan; a file that does not parse is listed as damaged and hides nothing else. */
  readonly list: (workspaceId: WorkspaceId) => Promise<PlanListing>
  readonly read: (workspaceId: WorkspaceId, planId: string) => Promise<Plan>
  readonly create: (workspaceId: WorkspaceId, plan: Plan) => Promise<Plan>
  /**
   * Checks the guard against the stored revision, then saves what `change` returns. The change keeps the
   * plan's identity and either keeps its revision (generate, baseline, a refresh with no new value) or
   * raises it by one (an input change).
   */
  readonly update: (workspaceId: WorkspaceId, planId: string, guard: RevisionGuard, change: (plan: Plan) => Plan | Promise<Plan>) => Promise<Plan>
  /** A damaged plan can be deleted only without an expected revision, since it has none to compare. */
  readonly delete: (workspaceId: WorkspaceId, planId: string, guard: RevisionGuard) => Promise<void>
}

/** The revision check every write makes. Missing: 400 with the current revision; stale: 409 with what changed since. */
export const assertRevision = (plan: Plan, guard: RevisionGuard): void => {
  if (guard.expectedRevision === undefined) {
    if (guard.required) throw planningError(400, 'plan_revision_required', 'Pass the plan\'s current revision as the expected revision', { currentRevision: plan.revision })
    return
  }
  if (guard.expectedRevision === plan.revision) return
  const expected = guard.expectedRevision
  const since = plan.changes.filter(change => change.revision > expected).slice(-6).map(change => ({ revision: change.revision, summary: change.summary }))
  throw planningError(409, 'plan_revision_conflict', `The plan is at revision ${plan.revision}, not ${expected}; read it again before changing it`, { currentRevision: plan.revision, since })
}

export interface PlanStoreOptions {
  /** Called after the temporary file is synced and before it replaces the plan; tests stop here to model a crash. */
  readonly beforeReplace?: (path: string) => Promise<void>
}

export const createPlanStore = (rootDirectory: string, options: PlanStoreOptions = {}): PlanStore => {
  const root = resolve(rootDirectory)
  const queues = new Map<string, Promise<void>>()
  const swept = new Set<string>()
  const moduleDirectory = (workspaceId: WorkspaceId) => join(root, 'workspaces', workspaceIdSchema.parse(workspaceId), 'planning')
  const plansDirectory = (workspaceId: WorkspaceId) => join(moduleDirectory(workspaceId), 'plans')
  const planPath = (workspaceId: WorkspaceId, planId: string) => join(plansDirectory(workspaceId), `${planIdSchema.parse(planId)}.json`)

  const serialize = async <T>(workspaceId: WorkspaceId, operation: () => Promise<T>): Promise<T> => {
    const key = workspaceIdSchema.parse(workspaceId)
    const previous = queues.get(key)
    let release!: () => void
    const current = new Promise<void>(complete => { release = complete })
    queues.set(key, current)
    if (previous !== undefined) await previous
    try { return await operation() } finally {
      release()
      if (queues.get(key) === current) queues.delete(key)
    }
  }

  const syncDirectory = async (directory: string): Promise<void> => {
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }

  const write = async (path: string, document: unknown): Promise<void> => {
    const directory = resolve(path, '..')
    const temporary = `${path}.${crypto.randomUUID()}${temporarySuffix}`
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try {
      await options.beforeReplace?.(path)
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    await syncDirectory(directory)
  }

  const requireWorkspace = async (workspaceId: WorkspaceId): Promise<void> => {
    const file = Bun.file(join(moduleDirectory(workspaceId), 'module.json'))
    if (!await file.exists()) throw planningError(404, 'workspace_not_found', 'Planning is not provisioned in this Workspace')
    const marker = markerSchema.parse(await file.json())
    if (marker.workspaceId !== workspaceId) throw planningError(500, 'invalid_workspace_state', 'Planning Workspace marker disagrees with its directory')
    if (swept.has(workspaceId)) return
    // A crash can leave a temporary file behind; nothing else writes here, so any one found now is stray.
    await mkdir(plansDirectory(workspaceId), { recursive: true })
    for (const name of await readdir(plansDirectory(workspaceId))) {
      if (name.endsWith(temporarySuffix)) await rm(join(plansDirectory(workspaceId), name), { force: true })
    }
    swept.add(workspaceId)
  }

  const parseStored = async (workspaceId: WorkspaceId, planId: string): Promise<{ readonly ok: true; readonly plan: Plan } | { readonly ok: false }> => {
    let raw: unknown
    try { raw = await Bun.file(planPath(workspaceId, planId)).json() } catch { return { ok: false } }
    const parsed = planSchema.safeParse(raw)
    if (!parsed.success || parsed.data.id !== planId || parsed.data.workspaceId !== workspaceId) return { ok: false }
    return { ok: true, plan: parsed.data }
  }

  const read = async (workspaceId: WorkspaceId, planId: string): Promise<Plan> => {
    await requireWorkspace(workspaceId)
    if (!planIdSchema.safeParse(planId).success || !await Bun.file(planPath(workspaceId, planId)).exists()) {
      throw planningError(404, 'plan_not_found', 'Plan not found')
    }
    const stored = await parseStored(workspaceId, planId)
    if (!stored.ok) throw planningError(500, 'plan_damaged', 'This plan\'s file cannot be read. It is kept unchanged on the server; it can be deleted.')
    return stored.plan
  }

  return {
    hasWorkspace: async workspaceId => {
      const exists = await Bun.file(join(moduleDirectory(workspaceId), 'module.json')).exists()
      if (exists) await serialize(workspaceId, () => requireWorkspace(workspaceId))
      return exists
    },
    provision: workspaceId => serialize(workspaceId, async () => {
      const marker = Bun.file(join(moduleDirectory(workspaceId), 'module.json'))
      if (await marker.exists()) { await requireWorkspace(workspaceId); return false }
      await mkdir(plansDirectory(workspaceId), { recursive: true })
      await write(join(moduleDirectory(workspaceId), 'module.json'), markerSchema.parse({ workspaceId, moduleId: 'planning' }))
      return true
    }),
    removeWorkspace: workspaceId => serialize(workspaceId, async () => {
      await rm(moduleDirectory(workspaceId), { recursive: true, force: true })
      swept.delete(workspaceIdSchema.parse(workspaceId))
    }),
    list: workspaceId => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const plans: Plan[] = []
      const damaged: DamagedPlan[] = []
      for (const name of (await readdir(plansDirectory(workspaceId))).filter(name => name.endsWith('.json')).sort()) {
        const id = name.slice(0, -'.json'.length)
        if (!planIdSchema.safeParse(id).success) continue
        const stored = await parseStored(workspaceId, id)
        if (stored.ok) plans.push(stored.plan)
        else damaged.push({ id })
      }
      return { plans: plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)), damaged }
    }),
    read: (workspaceId, planId) => serialize(workspaceId, () => read(workspaceId, planId)),
    create: (workspaceId, input) => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const plan = planSchema.parse(input)
      if (plan.workspaceId !== workspaceId) throw planningError(400, 'workspace_scope_mismatch', 'The plan belongs to another Workspace')
      if (await Bun.file(planPath(workspaceId, plan.id)).exists()) throw planningError(409, 'plan_exists', 'A plan with this id already exists')
      await write(planPath(workspaceId, plan.id), plan)
      return plan
    }),
    update: (workspaceId, planId, guard, change) => serialize(workspaceId, async () => {
      const previous = await read(workspaceId, planId)
      assertRevision(previous, guard)
      const next = planSchema.parse(await change(previous))
      if (next.id !== previous.id || next.workspaceId !== previous.workspaceId || (next.revision !== previous.revision && next.revision !== previous.revision + 1)) {
        throw planningError(500, 'invalid_plan_mutation', 'A plan change keeps its identity and raises its revision by at most one')
      }
      await write(planPath(workspaceId, planId), next)
      return next
    }),
    delete: (workspaceId, planId, guard) => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const path = planPath(workspaceId, planId)
      if (!await Bun.file(path).exists()) throw planningError(404, 'plan_not_found', 'Plan not found')
      const stored = await parseStored(workspaceId, planId)
      if (stored.ok) assertRevision(stored.plan, guard)
      else if (guard.expectedRevision !== undefined) throw planningError(409, 'plan_damaged', 'This plan\'s file cannot be read, so it has no revision to compare; delete it without one')
      await rm(path)
      await syncDirectory(plansDirectory(workspaceId))
    }),
  }
}
