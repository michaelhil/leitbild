/** Union eligibility is conservative across this original contiguous instance
 * run. Per-instance object rows remain authoritative for differing masks. */
export const updatePhysicalOpaqueRunMask = (rows: Float32Array, objects: number, start: number, count: number, mask: Uint8Array): boolean => {
  if (!Number.isInteger(objects) || objects < 0 || mask.length !== objects || !Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1 || (start + count) * objects * 12 > rows.length) throw Error('Physical visibility mask does not match its actual instance table')
  let changed = false
  for (let object = 0; object < objects; object++) {
    let visible = 0
    for (let instance = start; instance < start + count; instance++) {
      const alpha = rows[(instance * objects + object) * 12 + 7]!
      if (!Number.isFinite(alpha)) throw Error('Physical instance visibility must be finite')
      if (alpha >= 1) { visible = 1; break }
    }
    if (mask[object] !== visible) { mask[object] = visible; changed = true }
  }
  return changed
}
/** Preserve every original vertex/object ordinal and primitive endpoint order.
 * No triangle, line or authored edge is simplified or regenerated. */
export const physicalVisibleElements = (ranges: Uint32Array, mask: Uint8Array): { readonly solid: Uint32Array; readonly lines: Uint32Array } => {
  if (ranges.length !== mask.length * 4) throw Error('Physical visibility ranges do not match their source mesh ordinals')
  let solidCount = 0, lineCount = 0
  for (let mesh = 0; mesh < mask.length; mesh++) if (mask[mesh]) { solidCount += ranges[mesh * 4 + 1]!; lineCount += ranges[mesh * 4 + 3]! }
  const solid = new Uint32Array(solidCount), lines = new Uint32Array(lineCount)
  let a = 0, b = 0
  for (let mesh = 0; mesh < mask.length; mesh++) if (mask[mesh]) {
    const at = mesh * 4
    for (let vertex = ranges[at]!, end = vertex + ranges[at + 1]!; vertex < end; vertex++) solid[a++] = vertex
    for (let vertex = ranges[at + 2]!, end = vertex + ranges[at + 3]!; vertex < end; vertex++) lines[b++] = vertex
  }
  return { solid, lines }
}
