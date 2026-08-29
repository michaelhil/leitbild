import { $ } from 'bun'
import { join } from 'node:path'
import { createMapPipelineConfig } from './config.ts'

const config = createMapPipelineConfig()
const fontDir = join(config.fontsDir, config.fontStack)
const escapedFontStack = encodeURIComponent(config.fontStack).replaceAll('%20', '%20')

await $`mkdir -p ${fontDir}`

for (let start = 0; start <= 65_280; start += 256) {
  const end = start + 255
  const target = join(fontDir, `${start}-${end}.pbf`)
  const url = `${config.fontBaseUrl}/${escapedFontStack}/${start}-${end}.pbf`
  await $`curl -fL --retry 3 --connect-timeout 20 ${url} -o ${target}`
}

console.log(`Installed ${config.fontStack} MapLibre glyphs in ${fontDir}`)
