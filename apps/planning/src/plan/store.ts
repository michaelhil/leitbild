// One JSON file per plan at workspaces/<ws>/planning/plans/<uuid>.json. One writer per Workspace: every
// operation on a Workspace runs in its queue. A write goes to a temporary file that is synced, renamed over
// the plan and followed by a sync of the directory, so an acknowledged save survives a process crash and a
// reader never sees half a file (power loss rests on Linux fsync). The old studies/ folder is never read.
//
// A plan file is two JSON lines, written together in one atomic write: line 1 is the plan's catalogue
// summary (a few KB at most), line 2 the plan. A listing reads only line 1, with a bounded read, so it never
// holds a plan in memory; opening a plan checks that line 1 is the summary of line 2, or the plan is damaged.
// Line 2 holds each distinct baseline inputs copy once (`frozenInputs`), and a baseline names its copy; in
// memory a plan is the planSchema aggregate. A plan file is at most `maxPlanBytes` (4 MB): a larger write is
// refused with 413.
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { stableJson } from '@leitbild/module-runtime'
import { planningError } from '../errors.ts'
import { instantSchema, labelSchema, planInputsSchema, planSchema, wordsSchema, type Plan, type PlanInputs } from './schema.ts'

const planIdSchema = z.uuid()
const markerSchema = z.object({ workspaceId: workspaceIdSchema, moduleId: z.literal('planning') }).strict()
const temporarySuffix = '.tmp'
export const maxPlanBytes = 4_000_000
/** Line 1 fits in this many bytes (title 160 and purpose 600 characters, at most 4 bytes each, and the frame). */
const summaryReadBytes = 8_192

/** A baseline's inputs: `current` (the plan's own inputs in this file) or a key in frozenInputs. */
const baselineFileSchema = planSchema.shape.baselines.element.omit({ inputs: true }).extend({ inputs: z.string().min(1).max(32) }).strict()
const planFileSchema = planSchema.omit({ baselines: true }).extend({
  baselines: z.array(baselineFileSchema).max(32),
  frozenInputs: z.array(z.object({ key: z.string().min(1).max(32), inputs: planInputsSchema }).strict()).max(32),
}).strict()

const contentKey = (inputs: PlanInputs): string => createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16)

/**
 * What the solver and lane K's checker read of a plan: its inputs, with each World fact by value, unit and
 * basis only. A newer read time or label is no input change, as a refresh judges it (it raises the
 * revision exactly when this digest changes).
 */
export const inputsDigest = (inputs: PlanInputs): string => {
  const facts = inputs.world.facts.map(fact => [fact.locator, fact.id, fact.value, fact.unit ?? null, fact.basis] as const)
    .sort((left, right) => `${left[0]}\u0000${left[1]}`.localeCompare(`${right[0]}\u0000${right[1]}`))
  return createHash('sha256').update(JSON.stringify({ ...inputs, world: { facts } })).digest('hex')
}

/** The file form: every distinct baseline inputs copy stored once, the plan's current inputs never twice. */
export const encodePlan = (plan: Plan): z.infer<typeof planFileSchema> => {
  const current = JSON.stringify(plan.inputs)
  const frozen = new Map<string, PlanInputs>()
  const baselines = plan.baselines.map(({ inputs, ...baseline }) => {
    if (JSON.stringify(inputs) === current) return { ...baseline, inputs: 'current' }
    const key = contentKey(inputs)
    frozen.set(key, inputs)
    return { ...baseline, inputs: key }
  })
  return { ...plan, baselines, frozenInputs: [...frozen].map(([key, inputs]) => ({ key, inputs })) }
}

/**
 * Back to the aggregate. Every part was validated by planFileSchema, so the baselines are assembled without
 * parsing again, and baselines that share a copy share one object in memory.
 */
const decodePlan = (file: z.infer<typeof planFileSchema>): Plan | undefined => {
  const frozen = new Map(file.frozenInputs.map(entry => [entry.key, entry.inputs]))
  const { frozenInputs: _frozen, ...rest } = file
  const baselines: Plan['baselines'] = []
  for (const { inputs: key, ...baseline } of file.baselines) {
    const inputs = key === 'current' ? file.inputs : frozen.get(key)
    if (inputs === undefined) return undefined
    baselines.push({ ...baseline, inputs })
  }
  return { ...rest, baselines }
}

/** What the catalogue shows of a plan; a listing keeps only these, never whole plans. */
export const planSummarySchema = z.object({
  id: planIdSchema,
  title: labelSchema,
  purpose: wordsSchema.optional(),
  revision: z.number().int().positive(),
  updatedAt: instantSchema,
  linked: z.boolean(),
  optionCount: z.number().int().nonnegative().max(8),
  optionsOutOfDate: z.boolean(),
}).strict()
export type PlanSummary = z.infer<typeof planSummarySchema>
export const summarize = (plan: Plan): PlanSummary => ({
  id: plan.id, title: plan.inputs.settings.title,
  ...(plan.inputs.settings.purpose === undefined ? {} : { purpose: plan.inputs.settings.purpose }),
  revision: plan.revision, updatedAt: plan.updatedAt, linked: plan.inputs.settings.run !== null,
  // The plan's own options: a what-if (an extra rule or a goal solved first) is never one (walk W2).
  optionCount: (plan.options?.options ?? []).filter(option => option.variant.also === undefined && option.variant.lead === undefined).length,
  optionsOutOfDate: (plan.options?.options ?? []).some(option => option.inputsRevision !== plan.revision),
})

export interface DamagedPlan { readonly id: string }
export interface PlanListing { readonly plans: ReadonlyArray<PlanSummary>; readonly damaged: ReadonlyArray<DamagedPlan> }

/** The envelope revision a write states. `required: false` only for delete (L2). */
export interface RevisionGuard { readonly expectedRevision: number | undefined; readonly required: boolean }

export interface PlanStore {
  readonly hasWorkspace: (workspaceId: WorkspaceId) => Promise<boolean>
  readonly provision: (workspaceId: WorkspaceId) => Promise<boolean>
  readonly removeWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** Reads line 1 of each plan file only; a file whose line 1 does not parse as a summary is listed as damaged. */
  readonly list: (workspaceId: WorkspaceId) => Promise<PlanListing>
  readonly read: (workspaceId: WorkspaceId, planId: string) => Promise<Plan>
  readonly create: (workspaceId: WorkspaceId, plan: Plan) => Promise<Plan>
  /**
   * Checks the guard against the stored revision, then saves what `change` returns. The change keeps the
   * plan's identity and either keeps its revision (generate, baseline, a refresh with no new value) or
   * raises it by one (an input change).
   */
  readonly update: (workspaceId: WorkspaceId, planId: string, guard: RevisionGuard, change: (plan: Plan) => Plan | Promise<Plan>) => Promise<Plan>
  /** A damaged plan is never deleted here: after a rollback it may be a newer plan this version cannot read. */
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
  /** Stands in for the disk in tests: called after the temporary file is opened, before it is written. */
  readonly beforeWrite?: (path: string) => Promise<void>
  readonly maxPlanBytes?: number
}

const damagedText = 'This plan file could not be read; do not delete it, report it.'
const ioCode = (error: unknown): string | undefined => error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined

export const createPlanStore = (rootDirectory: string, options: PlanStoreOptions = {}): PlanStore => {
  const root = resolve(rootDirectory)
  const limit = options.maxPlanBytes ?? maxPlanBytes
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

  /** Any failure before the rename removes the temporary file, so a failed save leaves nothing behind. */
  const writeText = async (path: string, text: string): Promise<void> => {
    const temporary = `${path}.${crypto.randomUUID()}${temporarySuffix}`
    const handle = await open(temporary, 'wx')
    try {
      try {
        await options.beforeWrite?.(path)
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await options.beforeReplace?.(path)
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    await syncDirectory(resolve(path, '..'))
  }

  const writePlan = async (path: string, plan: Plan): Promise<void> => {
    // Both lines in one write, so the summary can never disagree with the plan it summarizes.
    const text = `${JSON.stringify(summarize(plan))}\n${JSON.stringify(encodePlan(plan))}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > limit) {
      throw planningError(413, 'plan_too_large', `This change would make the plan ${(bytes / 1e6).toFixed(1)} MB, more than the ${(limit / 1e6).toFixed(0)} MB a plan may hold; nothing was saved`, { bytes, limit })
    }
    await writeText(path, text)
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

  const unavailable = (error: unknown) => planningError(503, 'store_unavailable', 'Planning could not read its files just now; try again', { code: ioCode(error) ?? 'unknown' })

  /**
   * Not found, damaged, or the plan. Damaged: line 2 does not parse as a plan, or line 1 is not exactly its
   * summary. An I/O failure is neither: 503, retry.
   */
  const parseStored = async (workspaceId: WorkspaceId, planId: string): Promise<{ readonly kind: 'missing' } | { readonly kind: 'damaged' } | { readonly kind: 'plan'; readonly plan: Plan }> => {
    let text: string
    try { text = await Bun.file(planPath(workspaceId, planId)).text() } catch (error) {
      if (ioCode(error) === 'ENOENT') return { kind: 'missing' }
      throw unavailable(error)
    }
    const end = text.indexOf('\n')
    if (end < 0) return { kind: 'damaged' }
    let summary: unknown, raw: unknown
    try { summary = JSON.parse(text.slice(0, end)); raw = JSON.parse(text.slice(end + 1)) } catch { return { kind: 'damaged' } }
    const file = planFileSchema.safeParse(raw)
    const plan = file.success ? decodePlan(file.data) : undefined
    if (plan === undefined || plan.id !== planId || plan.workspaceId !== workspaceId) return { kind: 'damaged' }
    if (stableJson(summary) !== stableJson(summarize(plan))) return { kind: 'damaged' }
    return { kind: 'plan', plan }
  }

  /** Line 1 only, by a bounded read: the listing never loads a plan. */
  const readSummary = async (workspaceId: WorkspaceId, planId: string): Promise<{ readonly kind: 'missing' } | { readonly kind: 'damaged' } | { readonly kind: 'summary'; readonly summary: PlanSummary }> => {
    let head: string
    try {
      const handle = await open(planPath(workspaceId, planId), 'r')
      try {
        const buffer = Buffer.alloc(summaryReadBytes)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        head = buffer.subarray(0, bytesRead).toString('utf8')
      } finally { await handle.close() }
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { kind: 'missing' }
      throw unavailable(error)
    }
    const end = head.indexOf('\n')
    if (end < 0) return { kind: 'damaged' }
    let raw: unknown
    try { raw = JSON.parse(head.slice(0, end)) } catch { return { kind: 'damaged' } }
    const summary = planSummarySchema.safeParse(raw)
    return summary.success && summary.data.id === planId ? { kind: 'summary', summary: summary.data } : { kind: 'damaged' }
  }

  const read = async (workspaceId: WorkspaceId, planId: string): Promise<Plan> => {
    await requireWorkspace(workspaceId)
    if (!planIdSchema.safeParse(planId).success) throw planningError(404, 'plan_not_found', 'Plan not found')
    const stored = await parseStored(workspaceId, planId)
    if (stored.kind === 'missing') throw planningError(404, 'plan_not_found', 'Plan not found')
    if (stored.kind === 'damaged') throw planningError(500, 'plan_damaged', damagedText)
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
      await writeText(join(moduleDirectory(workspaceId), 'module.json'), `${JSON.stringify(markerSchema.parse({ workspaceId, moduleId: 'planning' }))}\n`)
      return true
    }),
    removeWorkspace: workspaceId => serialize(workspaceId, async () => {
      await rm(moduleDirectory(workspaceId), { recursive: true, force: true })
      swept.delete(workspaceIdSchema.parse(workspaceId))
    }),
    list: workspaceId => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const plans: PlanSummary[] = []
      const damaged: DamagedPlan[] = []
      for (const name of (await readdir(plansDirectory(workspaceId))).filter(name => name.endsWith('.json')).sort()) {
        const id = name.slice(0, -'.json'.length)
        if (!planIdSchema.safeParse(id).success) continue
        const stored = await readSummary(workspaceId, id)
        if (stored.kind === 'summary') plans.push(stored.summary)
        else if (stored.kind === 'damaged') damaged.push({ id })
      }
      return { plans: plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)), damaged }
    }),
    read: (workspaceId, planId) => serialize(workspaceId, () => read(workspaceId, planId)),
    create: (workspaceId, input) => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const plan = planSchema.parse(input)
      if (plan.workspaceId !== workspaceId) throw planningError(400, 'workspace_scope_mismatch', 'The plan belongs to another Workspace')
      if (await Bun.file(planPath(workspaceId, plan.id)).exists()) throw planningError(409, 'plan_exists', 'A plan with this id already exists')
      await writePlan(planPath(workspaceId, plan.id), plan)
      return plan
    }),
    update: (workspaceId, planId, guard, change) => serialize(workspaceId, async () => {
      const previous = await read(workspaceId, planId)
      assertRevision(previous, guard)
      const next = planSchema.parse(await change(previous))
      if (next.id !== previous.id || next.workspaceId !== previous.workspaceId || (next.revision !== previous.revision && next.revision !== previous.revision + 1)) {
        throw planningError(500, 'invalid_plan_mutation', 'A plan change keeps its identity and raises its revision by at most one')
      }
      // A stored status stands on its revision and formulation alone (lane K's check ran in the solver child),
      // so a write that changes what the solver and checker read must raise the revision; one that does not is
      // a programming error, refused, never saved (adversary, child-boundary residual risk).
      if (next.revision === previous.revision && inputsDigest(next.inputs) !== inputsDigest(previous.inputs)) {
        throw planningError(500, 'invalid_plan_mutation', 'A plan change that alters its inputs raises its revision')
      }
      await writePlan(planPath(workspaceId, planId), next)
      return next
    }),
    delete: (workspaceId, planId, guard) => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const stored = planIdSchema.safeParse(planId).success ? await parseStored(workspaceId, planId) : { kind: 'missing' as const }
      if (stored.kind === 'missing') throw planningError(404, 'plan_not_found', 'Plan not found')
      if (stored.kind === 'damaged') throw planningError(409, 'plan_damaged', damagedText)
      assertRevision(stored.plan, guard)
      await rm(planPath(workspaceId, planId))
      await syncDirectory(plansDirectory(workspaceId))
    }),
  }
}
