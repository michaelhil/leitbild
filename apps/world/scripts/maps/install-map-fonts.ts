import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createMapPipelineConfig } from './config.ts'
import { validateGlyphRange } from './glyph-validation.ts'

const config = createMapPipelineConfig()
const fontDir = join(config.fontsDir, config.fontStack)
const escapedFontStack = encodeURIComponent(config.fontStack)

await mkdir(fontDir, { recursive: true })
const staging = await mkdtemp(join(config.fontsDir, '.glyphs-'))
const ranges = Array.from({ length: 256 }, (_, index) => `${index * 256}-${index * 256 + 255}`)
let cursor = 0
try {
  const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (cursor < ranges.length) {
      const range = ranges[cursor++]!
      const response = await fetch(`${config.fontBaseUrl}/${escapedFontStack}/${range}.pbf`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Map glyph ${range}: HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      validateGlyphRange(bytes, config.fontStack, range)
      await Bun.write(join(staging, range + '.pbf'), bytes)
    }
  }))
  const failure = workers.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  // No installed range is replaced until every download has been validated.
  for (const range of ranges) await rename(join(staging, range + '.pbf'), join(fontDir, range + '.pbf'))
} finally { await rm(staging, { recursive: true, force: true }) }

console.log(`Installed ${config.fontStack} MapLibre glyphs in ${fontDir}`)
