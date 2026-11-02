import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resourceIdSchema, workspaceResourceReferenceSchema, type PerspectiveAdmission, type WorkspaceId } from '@leitbild/contracts'
import type { StorageBudget } from '@leitbild/module-runtime'
import type { SimulationRunId } from '../model/ids.ts'
import { createKeyedOperations } from '../storage/keyed-operations.ts'
import { writeAtomic } from '../storage/atomic-write.ts'
import { storedPerspectiveSchema, perspectiveFailure, perspectiveRoleDigest, type StoredPerspective } from './model.ts'

const incarnationSchema = z.object({ id: z.string().uuid() }).strict()
export { perspectiveRoleDigest } from './model.ts'

export interface PerspectiveStore {
  readonly prepare: (input: { runId: SimulationRunId; roleIds: ReadonlyArray<string>; requestId: string }) => Promise<StoredPerspective>
  readonly read: (id: string) => Promise<StoredPerspective>
  readonly change: (id: string, expectedRevision: number, change: (record: StoredPerspective) => StoredPerspective) => Promise<StoredPerspective>
  readonly admission: (record: StoredPerspective) => Promise<PerspectiveAdmission>
  readonly assertCurrent: (record: StoredPerspective) => Promise<void>
  readonly rotateRun: (runId: SimulationRunId) => Promise<void>
}

export const createPerspectiveStore = (config: {
  workspaceId: WorkspaceId; workspaceRoot: string; directory: string; storageBudget: StorageBudget;
  runExists: (runId: SimulationRunId) => Promise<boolean>;
}): PerspectiveStore => {
  const records = createKeyedOperations<string>(), incarnations = createKeyedOperations<SimulationRunId>()
  const pathFor = (id: string) => join(config.directory, 'admissions', `${resourceIdSchema.parse(id)}.json`)
  const incarnationPath = (runId: SimulationRunId) => join(config.directory, 'runs', `${runId}.json`)
  const readOptional = async (path: string): Promise<unknown | undefined> => {
    try { return JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  const write = async (path: string, value: unknown): Promise<void> => {
    const text = `${JSON.stringify(value)}\n`
    await config.storageBudget.withGrowth(config.workspaceRoot, Buffer.byteLength(text), async () => {
      await mkdir(join(path, '..'), { recursive: true })
      await writeAtomic(path, text)
    })
  }
  const read = async (id: string): Promise<StoredPerspective> => {
    const value = await readOptional(pathFor(id))
    if (value === undefined) throw perspectiveFailure('perspective_not_found', 'Perspective admission was not found', 404)
    const record = storedPerspectiveSchema.parse(value)
    if (record.admission.resource.workspaceId !== config.workspaceId || record.admission.resource.id !== id) throw perspectiveFailure('perspective_integrity_failed', 'Stored Perspective identity does not match its owner', 409)
    return record
  }
  const runIncarnation = async (runId: SimulationRunId, create: boolean): Promise<string | undefined> => {
    const value = await readOptional(incarnationPath(runId))
    if (value !== undefined) return incarnationSchema.parse(value).id
    if (!create) return undefined
    const id = randomUUID()
    await write(incarnationPath(runId), { id })
    return id
  }
  const current = async (record: StoredPerspective): Promise<boolean> =>
    await config.runExists(record.runId) && await runIncarnation(record.runId, false) === record.admission.runIncarnation
  const admission = async (record: StoredPerspective): Promise<PerspectiveAdmission> => {
    if (record.admission.status === 'revoked' || await current(record)) return structuredClone(record.admission)
    return { ...record.admission, status: 'revoked', revokedReason: 'The owning Run incarnation has ended' }
  }
  const assertCurrent = async (record: StoredPerspective): Promise<void> => {
    if (record.admission.status === 'revoked' || !await current(record)) throw perspectiveFailure('perspective_revoked', 'This Perspective admission has ended; prepare a fresh admission')
  }
  const save = async (record: StoredPerspective): Promise<void> => {
    const parsed = storedPerspectiveSchema.parse(record)
    try { await write(pathFor(parsed.admission.resource.id), parsed) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'storage_budget_exceeded') throw error
      throw perspectiveFailure('perspective_save_unconfirmed', 'Perspective persistence was not confirmed; read back this exact admission before retrying', 503,
        { resource: parsed.admission.resource })
    }
  }
  return {
    read, admission, assertCurrent,
    prepare: input => records.run(`perspective-${input.requestId}`, async () => {
      const id = resourceIdSchema.parse(`perspective-${z.string().uuid().parse(input.requestId)}`)
      const existing = await readOptional(pathFor(id))
      if (existing !== undefined) {
        const record = await read(id)
        if (record.prepareRequestId !== input.requestId || record.runId !== input.runId || record.admission.roleSetDigest !== perspectiveRoleDigest(input.roleIds)) throw perspectiveFailure('perspective_prepare_conflict', 'This prepare request already names another admission', 409)
        return record
      }
      if (!await config.runExists(input.runId)) throw perspectiveFailure('perspective_run_unavailable', 'The requested Run is unavailable', 404)
      const incarnation = await incarnations.run(input.runId, () => runIncarnation(input.runId, true))
      const at = new Date().toISOString()
      const record = storedPerspectiveSchema.parse({
        admission: { resource: workspaceResourceReferenceSchema.parse({ workspaceId: config.workspaceId, moduleId: 'world', type: 'world.perspective', id }),
          status: 'pending', revision: 0, admissionGeneration: randomUUID(), runIncarnation: incarnation, roleSetDigest: perspectiveRoleDigest(input.roleIds), createdAt: at, updatedAt: at },
        runId: input.runId, roleIds: input.roleIds, prepareRequestId: input.requestId,
      })
      await save(record)
      return record
    }),
    change: (id, expectedRevision, change) => records.run(id, async () => {
      const record = await read(id)
      if (record.admission.revision !== expectedRevision) throw perspectiveFailure('perspective_revision_conflict', 'Perspective admission changed; read it before retrying', 409)
      await assertCurrent(record)
      const next = storedPerspectiveSchema.parse(change(structuredClone(record)))
      if (next.admission.resource.id !== record.admission.resource.id || next.admission.admissionGeneration !== record.admission.admissionGeneration || next.runId !== record.runId || next.admission.runIncarnation !== record.admission.runIncarnation || JSON.stringify(next.roleIds) !== JSON.stringify(record.roleIds)) throw new Error('Perspective update attempted to change an immutable owner relationship')
      await save(next)
      return next
    }),
    rotateRun: runId => incarnations.run(runId, () => write(incarnationPath(runId), { id: randomUUID() })),
  }
}
