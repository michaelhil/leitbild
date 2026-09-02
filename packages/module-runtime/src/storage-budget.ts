import { opendir, lstat, statfs } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export interface StorageBudgetStatus {
  readonly allowed: boolean
  readonly reason: string | null
  readonly rootBytes: number | null
  readonly workspaceBytes: number | null
  readonly freeBytes: number | null
  readonly observedAt: string
}

/** Admission ceilings, not an OS quota. Periodic observations never delete data. */
export const createStorageBudget = (options: {
  readonly root: string
  readonly maxBytes?: number
  readonly maxWorkspaceBytes?: number
  readonly minFreeBytes?: number
  readonly cacheMs?: number
}) => {
  const root = resolve(options.root)
  const limits = {
    maxBytes: options.maxBytes ?? Number(process.env.LEITBILD_STORAGE_MAX_BYTES ?? 8 * 1024 ** 3),
    maxWorkspaceBytes: options.maxWorkspaceBytes ?? Number(process.env.LEITBILD_WORKSPACE_MAX_BYTES ?? 2 * 1024 ** 3),
    minFreeBytes: options.minFreeBytes ?? Number(process.env.LEITBILD_STORAGE_RESERVE_BYTES ?? 1024 ** 3),
  }
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid storage policy ${key}`)
  const cacheMs = options.cacheMs ?? 30_000
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0) throw new Error('Invalid storage inventory cache interval')
  let measuredAt = 0
  let sizes = new Map<string, number>()
  let scanError: string | null = null
  let scanning: Promise<void> | undefined
  const reservations = new Map<string, number>()

  const refresh = async (): Promise<void> => {
    if (scanning) return scanning
    if (Date.now() - measuredAt < cacheMs) return
    scanning = (async () => {
      const next = new Map<string, number>()
      let entries = 0
      const visit = async (path: string): Promise<number> => {
        if (++entries > 100_000) throw new Error('Storage inventory exceeds 100,000 entries; admission paused pending operator review')
        let info
        try { info = await lstat(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
          throw error
        }
        let bytes = info.size
        if (info.isDirectory()) {
          bytes = 0
          try { for await (const entry of await opendir(path)) bytes += await visit(join(path, entry.name)) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        next.set(path, bytes)
        return bytes
      }
      try { await visit(root); sizes = next; scanError = null }
      catch (error) { scanError = `Storage inventory unavailable: ${String(error)}` }
      measuredAt = Date.now()
    })().finally(() => { scanning = undefined })
    return scanning
  }
  const scopePath = (workspace: string) => {
    const path = resolve(workspace), child = relative(root, path)
    if (child === '..' || child.startsWith('../')) throw new Error('Storage scope is outside its Module root')
    return path
  }
  const inspect = async (workspace: string): Promise<StorageBudgetStatus> => {
    const path = scopePath(workspace)
    await refresh()
    let freeBytes: number | null = null
    let reason = scanError
    try {
      let parent = root
      for (;;) {
        try { const fs = await statfs(parent); freeBytes = fs.bavail * fs.bsize; break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error; parent = dirname(parent) }
      }
    } catch (error) { reason = `Free-space inventory unavailable: ${String(error)}` }
    const reserved = [...reservations.values()].reduce((sum, bytes) => sum + bytes, 0)
    const rootBytes = (sizes.get(root) ?? 0) + reserved
    const workspaceBytes = (sizes.get(path) ?? 0) + (reservations.get(path) ?? 0)
    if (reason === null && (rootBytes >= limits.maxBytes || workspaceBytes >= limits.maxWorkspaceBytes || freeBytes! - reserved < limits.minFreeBytes)) reason = 'Storage admission budget reached; remove/export data or adjust the operator policy before adding more'
    return { allowed: reason === null, reason, rootBytes, workspaceBytes, freeBytes, observedAt: new Date(measuredAt).toISOString() }
  }
  const withGrowth = async <T>(workspace: string, estimatedBytes: number, work: () => Promise<T>): Promise<T> => {
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) throw new Error('Invalid storage growth estimate')
    const path = scopePath(workspace)
    // Reserve before the asynchronous inventory, so concurrent admissions see one another.
    reservations.set(path, (reservations.get(path) ?? 0) + estimatedBytes)
    try {
      const status = await inspect(path)
      if (!status.allowed) throw Object.assign(new Error(status.reason!), { code: 'storage_budget_exceeded', status })
      return await work()
    } finally {
      const remaining = reservations.get(path)! - estimatedBytes
      if (remaining) reservations.set(path, remaining); else reservations.delete(path)
      measuredAt = 0
    }
  }
  return { inspect, withGrowth, limits }
}

export type StorageBudget = ReturnType<typeof createStorageBudget>
