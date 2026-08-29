import { $ } from 'bun'
import { join } from 'node:path'
import { createMapPipelineConfig } from './config.ts'

const config = createMapPipelineConfig()
const pmtilesPath = join(config.releaseDir, 'norway.pmtiles')
const capabilitiesPath = join(config.releaseDir, 'capabilities.json')
const stylePath = join(config.releaseDir, 'style.json')
const currentPath = join(config.rootDir, 'current')
const nextPath = join(config.rootDir, 'current.next')

await $`test -s ${pmtilesPath}`
await $`test -s ${capabilitiesPath}`
await $`test -s ${stylePath}`
await $`rm -rf ${nextPath}`
await $`ln -s ${config.releaseDir} ${nextPath}`
await $`rm -rf ${currentPath}`
await $`mv ${nextPath} ${currentPath}`

console.log(`Promoted vector tile release ${config.releaseDir} to ${currentPath}`)
