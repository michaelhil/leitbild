/** Navigation temporarily owns pointer intent; it does not replace base policy. */
export const createMapPickingDemand = (baseEnabled: boolean, apply: (enabled: boolean) => void) => {
  const leases = new Set<symbol>()
  let disposed = false, applied = baseEnabled
  const enabled = (): boolean => baseEnabled && leases.size === 0
  const sync = (): void => { const next = enabled(); if (next === applied) return; applied = next; apply(next) }
  const cancelLeases = (): void => { leases.clear(); sync() }
  return {
    enabled,
    setBaseEnabled(value: boolean): void { if (disposed) throw Error('Map picking demand is disposed'); baseEnabled = value; sync() },
    suspend(): () => void {
      if (disposed) throw Error('Map picking demand is disposed')
      const lease = Symbol('navigation'); leases.add(lease); sync()
      return () => { if (leases.delete(lease)) sync() }
    },
    cancelLeases,
    dispose(): void { if (disposed) return; cancelLeases(); disposed = true },
  }
}
