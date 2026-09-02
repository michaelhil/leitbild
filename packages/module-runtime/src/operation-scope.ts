/** Concurrent work owned by one lifetime. Closing rejects new work and drains accepted work. */
export const createOperationScope = (label: string) => {
  let closing = false
  const active = new Set<Promise<void>>()
  const acquire = (): (() => void) => {
    if (closing) throw Object.assign(new Error(`${label} is closing`), { code: 'workspace_closing' })
    let resolve!: () => void
    const done = new Promise<void>(complete => { resolve = complete })
    active.add(done)
    let released = false
    return () => {
      if (released) return
      released = true
      active.delete(done)
      resolve()
    }
  }
  return {
    acquire,
    activeCount: () => active.size,
    run: async <T>(work: () => Promise<T>): Promise<T> => {
      const release = acquire()
      try { return await work() } finally { release() }
    },
    close: async (): Promise<void> => {
      closing = true
      await Promise.all([...active])
    },
  }
}
