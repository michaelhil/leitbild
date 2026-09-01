// Scanner — list every installed pack under a root directory. Each immediate
// subdirectory is treated as a pack; hidden and underscore-prefixed names are
// skipped (matches skill-loader convention). Missing root resolves to [].

import type { Pack } from './types.ts'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readManifest } from './manifest.ts'

// scanPacks runs on every install/update/uninstall (for list_packs), every
// the Workspace-scoped Room Pack API (for activation validation), and every
// refreshPackGeodata. Without dedup, an orphan .prev sibling would emit
// the warning once per call — flooding logs after a single crashed update.
// Module-level Set lives for the process lifetime; bounded by operator's
// failed updates.
const warnedOrphanPaths = new Set<string>()
// Test seam — clear between tests so warn-once assertions don't leak.
export const __resetScannerWarnings = (): void => { warnedOrphanPaths.clear() }

export const scanPacks = async (rootDir: string): Promise<ReadonlyArray<Pack>> => {
  try {
    const s = await stat(rootDir)
    if (!s.isDirectory()) return []
  } catch {
    return []
  }

  const entries = (await readdir(rootDir)).sort((left, right) => left.localeCompare(right))
  const packs: Pack[] = []

  for (const entry of entries) {
    // Orphan rollback snapshots from a crashed update_pack. Scanner skips
    // them (they're not packs) but surfaces a warning so the operator can
    // inspect + remove. update_pack also refuses to run when one exists.
    // Warn-once per path so subsequent scans don't flood the logs.
    if (entry.endsWith('.prev')) {
      const fullPath = join(rootDir, entry)
      if (!warnedOrphanPaths.has(fullPath)) {
        warnedOrphanPaths.add(fullPath)
        console.warn(`[packs] orphan rollback snapshot: ${fullPath} — a previous update_pack crashed before cleanup. Inspect and remove manually.`)
      }
      continue
    }
    if (entry.startsWith('.') || entry.startsWith('_')) continue
    const dirPath = join(rootDir, entry)
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) continue
    } catch { continue }

    const manifest = await readManifest(dirPath)
    const id = manifest.descriptor.id
    if (entry !== id) {
      throw new Error(`${join(dirPath, 'pack.json')}: descriptor.id ${id} must match Pack directory name ${entry}`)
    }
    packs.push({ id, dirPath, manifest })
  }

  return packs
}

// Helper for sub-system loaders that want a flat list of pack subdirs of a
// given kind (scripts/, geodata/, wikis/). Returns one entry per existing
// subdir — packs that don't ship that subdir are silently omitted.
export const scanPackSubdirs = async (
  rootDir: string,
  subdir: 'scripts' | 'geodata' | 'wikis',
): Promise<ReadonlyArray<{ readonly pack: string; readonly dir: string }>> => {
  const packs = await scanPacks(rootDir)
  const out: Array<{ pack: string; dir: string }> = []
  for (const p of packs) {
    const candidate = join(p.dirPath, subdir)
    try {
      const s = await stat(candidate)
      if (s.isDirectory()) out.push({ pack: p.id, dir: candidate })
    } catch { /* no such subdir — fine, packs choose what to ship */ }
  }
  return out
}
