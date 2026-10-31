/** The host's settled reactive flush, not a timer or a subsequent animation
 * frame, owns one complete paint. Callers supply immutable current paint
 * intents; repeated invalidations replace the intent before that flush settles.
 * Native drawing order, paths, composition and raster quality remain the
 * painter's responsibility and are never combined or modified here. */
export const createPhysicalPaintCoalescer = <T>(options: {
  readonly flush: () => Promise<unknown>
  readonly paint: (intent: T) => void
  readonly reportError: (error: Error) => void
}) => {
  let latest: { readonly value: T } | null = null
  let pending: object | null = null
  let destroyed = false
  const report = (error: unknown): void => options.reportError(error instanceof Error ? error : new Error(String(error)))
  const settle = async (job: object): Promise<void> => {
    try { await options.flush() }
    catch (error) {
      if (destroyed || pending !== job) return
      pending = null; latest = null; report(error); return
    }
    if (destroyed || pending !== job) return
    pending = null
    const intent = latest; latest = null
    if (!intent) return
    try { options.paint(intent.value) }
    catch (error) { report(error) }
  }
  const cancel = (): void => { pending = null; latest = null }
  return {
    request(intent: T): void {
      if (destroyed) return
      latest = { value: intent }
      if (pending !== null) return
      const job = {}; pending = job; void settle(job)
    },
    /** A new request may start immediately; an obsolete flush never owns it. */
    cancel,
    destroy(): void { destroyed = true; cancel() },
  }
}
