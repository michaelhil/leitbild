import type { SimulationRunId } from '../../core/model/index.ts'
import {
  listProcessDisplays, readProcessDisplay, readProcessDisplaySnapshot,
  type ProcessDisplaySnapshot,
} from './process-display-client.ts'

const displayClient = { list: listProcessDisplays, read: readProcessDisplay, snapshot: readProcessDisplaySnapshot }

// One floating window owns one session. No shared cache of live Plant values.
// Closing the window invalidates every outstanding response, including startup.
export const createProcessDisplaySession = (config: {
  readonly runId: SimulationRunId
  readonly plantId: string
  readonly onSnapshot: (snapshot: ProcessDisplaySnapshot) => void
  readonly onRefreshError: (message: string | null) => void
  readonly client?: typeof displayClient
}) => {
  const client = config.client ?? displayClient
  let closed = false
  let displayId: string | undefined
  let pendingRefresh: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = (): Promise<void> => {
    if (closed || displayId === undefined) return Promise.resolve()
    if (pendingRefresh) return pendingRefresh
    const selectedDisplayId = displayId
    pendingRefresh = (async () => {
      try {
        const snapshot = await client.snapshot(config.runId, config.plantId, selectedDisplayId)
        if (closed) return
        config.onSnapshot(snapshot)
        config.onRefreshError(null)
      } catch (error) {
        if (!closed) config.onRefreshError(error instanceof Error ? error.message : String(error))
      } finally { pendingRefresh = undefined }
    })()
    return pendingRefresh
  }

  const load = async () => {
    if (closed) return null
    const displays = await client.list(config.runId, config.plantId)
    if (closed) return null
    const first = displays[0]
    if (!first) throw new Error(`no process displays are available for ${config.plantId}`)
    // Both are addressed by the discovered id; neither depends on the other.
    const [display, snapshot] = await Promise.all([
      client.read(config.runId, config.plantId, first.id),
      client.snapshot(config.runId, config.plantId, first.id),
    ])
    if (closed) return null
    displayId = first.id
    return { display, snapshot }
  }

  return {
    load, refresh,
    startRefreshing: (): void => {
      if (closed || displayId === undefined) return
      clearInterval(timer)
      timer = setInterval(() => { void refresh() }, 1_000)
    },
    close: (): void => { closed = true; clearInterval(timer) },
  }
}
