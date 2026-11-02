import { workspaceResourceReferenceSchema, type WorkspaceResourceReference } from '@leitbild/contracts'

export interface RunAssistantResolution {
  readonly run: WorkspaceResourceReference
  readonly room: WorkspaceResourceReference
}
const same = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean => a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id

/** One pending open per exact Run. An admitted Room remains real after navigation, but cannot select another Run's UI. */
export const createRunAssistantOpening = (config: {
  current: () => WorkspaceResourceReference | null
  resolve: (run: WorkspaceResourceReference, assertCurrent: () => void) => Promise<RunAssistantResolution>
}) => {
  const pending = new Map<string, Promise<RunAssistantResolution>>()
  return (): Promise<RunAssistantResolution> => {
    const current = config.current()
    if (!current) return Promise.reject(new Error('No Run is currently shown'))
    const run = workspaceResourceReferenceSchema.parse(current)
    if (run.moduleId !== 'world' || run.type !== 'world.simulation-run') return Promise.reject(new Error('The Assistant belongs to an exact World Run'))
    const key = JSON.stringify([run.workspaceId, run.moduleId, run.type, run.id])
    const existing = pending.get(key)
    if (existing) return existing
    const assertCurrent = (): void => {
      const shown = config.current()
      if (!shown || !same(shown, run)) throw new Error('The Run changed while its Assistant was opening; open the Assistant for the Run now shown')
    }
    const opening = (async (): Promise<RunAssistantResolution> => {
      assertCurrent()
      const result = await config.resolve(run, assertCurrent)
      assertCurrent()
      const resolvedRun = workspaceResourceReferenceSchema.parse(result.run), room = workspaceResourceReferenceSchema.parse(result.room)
      if (!same(resolvedRun, run) || room.workspaceId !== run.workspaceId || room.moduleId !== 'agents' || room.type !== 'agents.room') throw new Error('The Assistant response does not name this Run and its exact Agents Room')
      return { run: resolvedRun, room }
    })().finally(() => { if (pending.get(key) === opening) pending.delete(key) })
    pending.set(key, opening)
    return opening
  }
}
