import { $ } from 'bun'
import { dirname } from 'node:path'
import { createMapPipelineConfig } from './config.ts'

const config = createMapPipelineConfig()
const tmpPath = `${config.sourcePath}.download`

await $`mkdir -p ${dirname(config.sourcePath)}`
await $`curl -fL --retry 3 --connect-timeout 20 ${config.sourceUrl} -o ${tmpPath}`
await $`mv ${tmpPath} ${config.sourcePath}`

console.log(`Downloaded OSM source to ${config.sourcePath}`)
