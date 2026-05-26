import type { LicenceRef } from '../../reference-data/types.ts'

// Compose MapLibre attribution strings from reference-data licence refs.
// MapLibre takes a single string per source; we deduplicate by licence id and
// join with " • " (the same convention MapLibre's built-in control uses).

export const composeAttribution = (licences: ReadonlyArray<LicenceRef>): string => {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const licence of licences) {
    const key = String(licence.id)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(licence.attribution)
  }
  return lines.join(' • ')
}

export const composeAttributionFromManifest = (manifest: {
  readonly licences: ReadonlyArray<{
    readonly id: string
    readonly attribution: string
  }>
}): string => {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const entry of manifest.licences) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    lines.push(entry.attribution)
  }
  return lines.join(' • ')
}
