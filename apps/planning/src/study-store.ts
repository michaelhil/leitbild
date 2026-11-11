import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { planningError } from './errors.ts'
import { studySchema, type Study } from './study-model.ts'

const studyIdSchema = z.uuid()
const markerSchema = z.object({ workspaceId: workspaceIdSchema, moduleId: z.literal('planning') }).strict()

export interface StudyStore {
  readonly hasWorkspace: (workspaceId: WorkspaceId) => Promise<boolean>
  readonly provision: (workspaceId: WorkspaceId) => Promise<boolean>
  readonly removeWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  readonly list: (workspaceId: WorkspaceId) => Promise<ReadonlyArray<Study>>
  readonly read: (workspaceId: WorkspaceId, studyId: string) => Promise<Study>
  readonly create: (workspaceId: WorkspaceId, study: Study) => Promise<Study>
  readonly update: (workspaceId: WorkspaceId, studyId: string, expectedRevision: number, change: (study: Study) => Study) => Promise<Study>
  /** Without an expected revision the delete is unconditional, as a person confirmed it. */
  readonly delete: (workspaceId: WorkspaceId, studyId: string, expectedRevision: number | undefined) => Promise<void>
}

/** One writer per Workspace. Slow owner reads happen outside this queue and commit with a revision check. */
export const createStudyStore = (rootDirectory: string): StudyStore => {
  const root = resolve(rootDirectory)
  const queues = new Map<string, Promise<void>>()
  const pathFor = (workspaceId: WorkspaceId) => join(root, 'workspaces', workspaceIdSchema.parse(workspaceId), 'planning')
  const studyPath = (workspaceId: WorkspaceId, studyId: string) => join(pathFor(workspaceId), 'studies', `${studyIdSchema.parse(studyId)}.json`)
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
  const requireWorkspace = async (workspaceId: WorkspaceId): Promise<void> => {
    const file = Bun.file(join(pathFor(workspaceId), 'module.json'))
    if (!await file.exists()) throw planningError(404, 'workspace_not_found', 'Planning is not provisioned in this Workspace')
    const marker = markerSchema.parse(await file.json())
    if (marker.workspaceId !== workspaceId) throw planningError(500, 'invalid_workspace_state', 'Planning Workspace marker disagrees with its directory')
  }
  const write = async (path: string, document: unknown): Promise<void> => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    try {
      await Bun.write(temporary, `${JSON.stringify(document)}\n`)
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  const read = async (workspaceId: WorkspaceId, studyId: string): Promise<Study> => {
    await requireWorkspace(workspaceId)
    const file = Bun.file(studyPath(workspaceId, studyId))
    if (!await file.exists()) throw planningError(404, 'study_not_found', 'Planning Study not found')
    const study = studySchema.parse(await file.json())
    if (study.id !== studyId || study.workspaceId !== workspaceId) throw planningError(500, 'invalid_study_state', 'Study identity disagrees with its directory')
    return study
  }
  const assertRevision = (study: Study, expectedRevision: number): void => {
    if (study.revision !== expectedRevision) throw planningError(409, 'study_revision_conflict', 'The Study changed; read its current revision before editing', { expectedRevision, actualRevision: study.revision })
  }
  return {
    hasWorkspace: async workspaceId => {
      const exists = await Bun.file(join(pathFor(workspaceId), 'module.json')).exists()
      if (exists) await requireWorkspace(workspaceId)
      return exists
    },
    provision: workspaceId => serialize(workspaceId, async () => {
      const path = pathFor(workspaceId)
      const marker = Bun.file(join(path, 'module.json'))
      if (await marker.exists()) { await requireWorkspace(workspaceId); return false }
      await mkdir(join(path, 'studies'), { recursive: true })
      await write(join(path, 'module.json'), markerSchema.parse({ workspaceId, moduleId: 'planning' }))
      return true
    }),
    removeWorkspace: workspaceId => serialize(workspaceId, async () => {
      await rm(pathFor(workspaceId), { recursive: true, force: true })
    }),
    list: workspaceId => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const files = await readdir(join(pathFor(workspaceId), 'studies'))
      const studies: Study[] = []
      for (const name of files.filter(name => name.endsWith('.json')).sort()) studies.push(await read(workspaceId, name.slice(0, -5)))
      return studies.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    }),
    read: (workspaceId, studyId) => serialize(workspaceId, () => read(workspaceId, studyId)),
    create: (workspaceId, input) => serialize(workspaceId, async () => {
      await requireWorkspace(workspaceId)
      const study = studySchema.parse(input)
      if (study.workspaceId !== workspaceId) throw planningError(400, 'workspace_scope_mismatch', 'Study belongs to another Workspace')
      const path = studyPath(workspaceId, study.id)
      if (await Bun.file(path).exists()) throw planningError(409, 'study_exists', 'Study already exists')
      await write(path, study)
      return study
    }),
    update: (workspaceId, studyId, expectedRevision, change) => serialize(workspaceId, async () => {
      const previous = await read(workspaceId, studyId)
      assertRevision(previous, expectedRevision)
      const next = studySchema.parse(change(previous))
      if (next.id !== previous.id || next.workspaceId !== previous.workspaceId || next.revision !== previous.revision + 1) {
        throw planningError(500, 'invalid_study_mutation', 'A Study mutation must preserve identity and advance its revision once')
      }
      await write(studyPath(workspaceId, studyId), next)
      return next
    }),
    delete: (workspaceId, studyId, expectedRevision) => serialize(workspaceId, async () => {
      const study = await read(workspaceId, studyId)
      if (expectedRevision !== undefined) assertRevision(study, expectedRevision)
      await rm(studyPath(workspaceId, studyId))
    }),
  }
}
