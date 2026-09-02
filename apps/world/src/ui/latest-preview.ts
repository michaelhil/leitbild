/** Bound expensive preview work to one request and the latest pending draft. */
export const createLatestPreview = <T, R>(config: {
  run: (input: T) => Promise<R>
  success: (value: R) => void
  failure: (error: unknown) => void
  delayMs: number
}) => {
  let generation = 0
  let pending: { input: T; generation: number } | undefined
  let running = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const drain = async (): Promise<void> => {
    if (running || disposed || !pending) return
    const job = pending
    pending = undefined
    running = true
    try {
      const result = await config.run(job.input)
      if (!disposed && job.generation === generation) config.success(result)
    } catch (error) {
      if (!disposed && job.generation === generation) config.failure(error)
    } finally {
      running = false
      if (pending && !disposed) void drain()
    }
  }
  return {
    schedule: (input: T): void => {
      pending = { input, generation: ++generation }
      clearTimeout(timer)
      timer = setTimeout(() => { void drain() }, config.delayMs)
    },
    cancel: (): void => { generation++; pending = undefined; clearTimeout(timer) },
    dispose: (): void => { disposed = true; generation++; pending = undefined; clearTimeout(timer) },
  }
}
