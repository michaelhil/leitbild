import { physicalPreparedGeometryBuffers, type PhysicalPreparedGeometry } from './preparation.ts'

export interface PhysicalPreparedResidencyMetrics {
  readonly residentViews: number
  /** Owned typed buffers, deduplicated across placements and retained variants. */
  readonly residentBytes: number
  readonly peakRequiredBytes: number
  readonly evictions: number
}
interface Resident { readonly asset: PhysicalPreparedGeometry; readonly buffers: ReadonlySet<ArrayBufferLike>; lastUsed: number }

/** CPU geometry is required by operational picks in vector Plan as well as 3D.
 * Its lifetime must not depend on whether a view uploads a WebGL representation.
 * The measured peak of the actual required working set is the retention budget;
 * inactive variants are evicted by recency, never by model/view count. */
export const createPhysicalPreparedResidency = () => {
  const residents = new Map<string, Resident>(), storage = new Map<ArrayBufferLike, number>()
  const inventories = new WeakMap<PhysicalPreparedGeometry, ReadonlySet<ArrayBufferLike>>()
  let required = new Map<string, PhysicalPreparedGeometry>(), bytes = 0, peak = 0, evictions = 0, revision = 0
  const inventory = (asset: PhysicalPreparedGeometry) => {
    let value = inventories.get(asset)
    if (!value) { value = physicalPreparedGeometryBuffers(asset); inventories.set(asset, value) }
    return value
  }
  const add = (asset: PhysicalPreparedGeometry): void => {
    const buffers = inventory(asset)
    for (const buffer of buffers) { const previous = storage.get(buffer) ?? 0; if (!previous) bytes += buffer.byteLength; storage.set(buffer, previous + 1) }
    residents.set(asset.key, { asset, buffers, lastUsed: revision })
  }
  const remove = (key: string): void => {
    const value = residents.get(key); if (!value) return
    for (const buffer of value.buffers) { const previous = storage.get(buffer)!; if (previous === 1) { storage.delete(buffer); bytes -= buffer.byteLength } else storage.set(buffer, previous - 1) }
    residents.delete(key)
  }
  const trim = (): void => {
    for (const [key] of [...residents].filter(([key]) => !required.has(key)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)) {
      if (bytes <= peak) break
      remove(key); evictions++
    }
  }
  return {
    update(values: ReadonlyArray<PhysicalPreparedGeometry>): void {
      const next = new Map<string, PhysicalPreparedGeometry>()
      for (const value of values) {
        const base = value.sourceAsset ?? value, previous = next.get(base.key) ?? residents.get(base.key)?.asset
        if (previous && previous !== base) throw new Error('Prepared geometry key changed while its immutable CPU asset was resident')
        next.set(base.key, base)
      }
      if (next.size === required.size && [...next].every(([key, asset]) => required.get(key) === asset)) return
      revision++
      const buffers = new Set<ArrayBufferLike>()
      for (const [key, asset] of next) {
        const previous = residents.get(key)
        if (previous) previous.lastUsed = revision; else add(asset)
        for (const buffer of inventory(asset)) buffers.add(buffer)
      }
      peak = Math.max(peak, [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0)); required = next; trim()
    },
    retainIdentities(identities: ReadonlySet<string>): void {
      let changed = false
      for (const [key, value] of residents) if (!identities.has(value.asset.identity)) { required.delete(key); remove(key); changed = true }
      if (changed) {
        const buffers = new Set([...required.values()].flatMap(asset => [...inventory(asset)]))
        peak = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0); trim()
      }
    },
    metrics: (): PhysicalPreparedResidencyMetrics => ({ residentViews: residents.size, residentBytes: bytes, peakRequiredBytes: peak, evictions }),
    clear(): void { residents.clear(); storage.clear(); required.clear(); bytes = 0; peak = 0 },
  }
}
